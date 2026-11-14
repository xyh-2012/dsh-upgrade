/**
 * Running npm to move the install to a new version.
 *
 * Two things this must get right on Windows:
 *
 * 1. `npm` is a `.cmd` shim, and Node refuses to spawn `.cmd` without
 *    `shell: true` (CVE-2024-27980 mitigation). Routing through
 *    `node <npm-cli.js>` avoids the shell entirely — no quoting hazards,
 *    no `cmd.exe` in the middle, and the exit code stays meaningful.
 * 2. The dependency is a `file:` tarball pinned in the root manifest, so the
 *    tarball must land in the root first and the manifest must be updated
 *    alongside it. Installing a bare version range would leave the old pin in
 *    place and silently upgrade nothing.
 *
 * @module dsh-upgrade/npm
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Locate the npm CLI script that runs under the current node.
 * @returns {string | undefined} absolute path to `npm-cli.js`.
 */
export function findNpmCli() {
  const local = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(local)) return local;
  const alt = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
  return existsSync(alt) ? alt : undefined;
}

/**
 * Stream a child process to completion, collecting both output streams.
 * @param {string} command - executable path.
 * @param {string[]} args - arguments.
 * @param {object} [options] - `{ cwd, env, signal, timeoutMs, onLine }`.
 * @returns {Promise<{code: number | null, stdout: string, stderr: string}>} result.
 */
export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 0;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      fn(value);
    };
    const consume = (chunk, isError) => {
      const text = chunk.toString('utf8');
      if (isError) stderr += text;
      else stdout += text;
      if (typeof options.onLine === 'function') {
        for (const line of text.split(/\r?\n/u)) {
          if (line.trim().length > 0) options.onLine(line, isError);
        }
      }
    };
    child.stdout?.on('data', (chunk) => consume(chunk, false));
    child.stderr?.on('data', (chunk) => consume(chunk, true));
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => finish(resolve, { code, stdout, stderr }));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(reject, new Error(`command timed out after ${timeoutMs} ms: ${command}`));
      }, timeoutMs);
    }
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        child.kill('SIGKILL');
        finish(reject, new Error('cancelled'));
      } else {
        options.signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
      }
    }
  });
}

/**
 * Compute a file digest.
 * @param {string} path - absolute path.
 * @param {string} algorithm - `sha512` or `sha1`.
 * @param {'hex'|'base64'} [encoding] - output encoding.
 * @returns {string} the digest.
 */
function digestFile(path, algorithm, encoding = 'hex') {
  const hash = createHash(algorithm);
  hash.update(readFileSync(path));
  return hash.digest(encoding);
}

/**
 * Verify a downloaded tarball against the registry's published hashes.
 *
 * `integrity` is an SRI string (`sha512-<base64>`); `shasum` is plain SHA-1
 * hex. Either is enough, both is better.
 *
 * @param {string} path - downloaded tarball.
 * @param {{integrity?: string, shasum?: string}} dist - registry dist block.
 * @returns {{ok: boolean, checked: string[], detail: string}} verification result.
 */
export function verifyTarball(path, dist) {
  const checked = [];
  if (typeof dist.shasum === 'string' && dist.shasum.length > 0) {
    const actual = digestFile(path, 'sha1');
    checked.push('sha1');
    if (actual.toLowerCase() !== dist.shasum.toLowerCase()) {
      return { ok: false, checked, detail: `sha1 mismatch: registry ${dist.shasum}, file ${actual}` };
    }
  }
  if (typeof dist.integrity === 'string' && dist.integrity.startsWith('sha512-')) {
    // SRI carries the digest base64-encoded, not hex.
    const expected = dist.integrity.slice('sha512-'.length);
    const actual = digestFile(path, 'sha512', 'base64');
    checked.push('sha512');
    if (actual !== expected) {
      return { ok: false, checked, detail: 'sha512 integrity mismatch' };
    }
  }
  if (checked.length === 0) {
    return { ok: false, checked, detail: 'registry published no hash to verify against' };
  }
  return { ok: true, checked, detail: `verified (${checked.join(' + ')})` };
}

/**
 * Download a tarball into `directory`, atomically replacing any previous copy.
 * @param {object} options - `{ url, directory, fileName, signal, timeoutMs }`.
 * @returns {Promise<string>} the downloaded file path.
 */
export async function downloadTarball(options) {
  const { url, directory, fileName } = options;
  mkdirSync(directory, { recursive: true });
  const target = join(directory, fileName);
  const partial = `${target}.part`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 300_000);
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`download failed: ${response.status} ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(partial, buffer);
    if (existsSync(target)) rmSync(target, { force: true });
    renameSync(partial, target);
    return target;
  } finally {
    clearTimeout(timer);
    if (existsSync(partial)) {
      try {
        rmSync(partial, { force: true });
      } catch {
        // A leftover partial file is harmless; the next run overwrites it.
      }
    }
  }
}

/**
 * Run `npm install` for a tarball inside the install root.
 * @param {object} options - `{ root, tarball, signal, onLine, dryRun, noScripts }`.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} result.
 */
export async function npmInstallTarball(options) {
  const npmCli = findNpmCli();
  if (npmCli === undefined) {
    throw new Error('could not find npm-cli.js next to the running node');
  }
  const args = [npmCli, 'install', options.tarball, '--no-audit', '--no-fund'];
  if (options.dryRun === true) args.push('--dry-run');
  if (options.noScripts === true) args.push('--ignore-scripts');
  return await runCommand(process.execPath, args, {
    cwd: options.root,
    signal: options.signal,
    onLine: options.onLine,
    timeoutMs: options.timeoutMs ?? 30 * 60_000,
  });
}

/**
 * Rewrite the `@deepseek-ai/dsh` dependency to point at a tarball file name.
 *
 * `npm install <tarball>` records a `file:` spec only when the tarball is
 * passed as a path; installing from a URL records the URL instead. Pinning the
 * relative file name keeps the manifest portable and matches how this install
 * was originally created.
 *
 * @param {string} root - install root.
 * @param {string} fileName - tarball file name inside the root.
 * @returns {{changed: boolean, previous: string, next: string}} what happened.
 */
export function pinDependency(root, fileName) {
  const path = join(root, 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.dependencies = manifest.dependencies ?? {};
  const previous = manifest.dependencies['@deepseek-ai/dsh'] ?? '';
  const next = `file:${fileName}`;
  if (previous === next) return { changed: false, previous, next };
  manifest.dependencies['@deepseek-ai/dsh'] = next;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { changed: true, previous, next };
}
