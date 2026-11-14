/**
 * dsh-upgrade — keep this DSH installation on the newest published build.
 *
 * The install is pinned by an npm dist-tag that is not always the newest
 * build (`latest` once pointed at a release older than `next`), so "upgrade"
 * here means "install the maximum published version and prove the CLI agrees",
 * not "run `npm i @deepseek-ai/dsh@latest`".
 *
 * @module dsh-upgrade
 */
import { readFileSync } from 'node:fs';
import { defineTool } from './lib/sdk.js';
import { detectInstallRoot, installedVersion } from './lib/install.js';
import { PACKAGE_NAME, fetchPackument, pickTargetVersion, resolveRegistry } from './lib/registry.js';
import { applyUpgrade, probe, readLastRun, verifyInstall } from './lib/upgrade.js';
import {
  confirmSelfRestart,
  readRestartReport,
  readSelfRestart,
  scheduleRestart,
} from './lib/restart.js';

/** Package name, also used as the bundle id. */
export const name = 'dsh-upgrade';

/** Services this plugin needs before `apply` runs. */
export const inject = ['tools'];

/** Defaults merged under whatever the profile passes. */
const DEFAULTS = {
  channel: 'newest',
  registry: '',
  root: '',
  autoRestart: false,
  restartMode: 'auto',
  restartDelaySeconds: 6,
};

/**
 * Merge user configuration over the defaults.
 * @param {object | undefined} config - raw configuration.
 * @returns {object} effective configuration.
 */
function withDefaults(config) {
  const merged = { ...DEFAULTS };
  if (config !== null && typeof config === 'object') {
    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined && value !== null && value !== '') merged[key] = value;
    }
  }
  return merged;
}

/**
 * Render a `text` block list for a tool result.
 * @param {string[]} lines - lines of text.
 * @returns {Array<{type: string, text: string}>} render payload.
 */
function text(...lines) {
  return [{ type: 'text', text: lines.join('\n') }];
}

/** Build the plugin. */
export function apply(ctx, config) {
  const settings = withDefaults(config);

  const resolveRoot = (explicit) => detectInstallRoot({
    explicit: typeof explicit === 'string' && explicit.length > 0
      ? explicit
      : (settings.root.length > 0 ? settings.root : undefined),
  });

  const registryFor = (root) => resolveRegistry(
    typeof settings.registry === 'string' && settings.registry.length > 0
      ? settings.registry
      : undefined,
    root,
  );

  // A restart this plugin asked for is proven by the fact that we are running
  // now: record it before anything else can fail, so the next status call can
  // show that the new build really is the one answering.
  try {
    const loadRoot = resolveRoot();
    const confirmed = confirmSelfRestart(loadRoot, { version: installedVersion(loadRoot) });
    if (confirmed !== null) {
      ctx.logger?.info?.(`dsh-upgrade: restart confirmed (${confirmed.requestedMode}, waited ${String(confirmed.waitedMs)}ms)`);
    }
  } catch {
    // A missing or unreadable state directory must never stop the plugin loading.
  }

  ctx.tools.register(defineTool({
    name: 'dsh_upgrade_status',
    description:
      'Report the installed DSH version, what the registry publishes, which version an upgrade '
      + 'would target, and whether a newer build exists. Read-only: it never touches the disk.',
    parameters: {
      root: {
        type: 'string',
        description: 'Install root to inspect. Defaults to the install this process runs from.',
      },
      channel: {
        type: 'string',
        description: "Version channel: 'newest' (default, max published), 'latest', 'next', 'alpha', or an exact version.",
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true, description: 'install root' },
          installedVersion: { type: 'string', required: true, description: 'version on disk' },
          targetVersion: { type: 'string', required: true, description: 'version an upgrade targets' },
          updateAvailable: { type: 'boolean', required: true, description: 'whether target is newer' },
          distTags: { type: 'json', description: 'registry dist-tags' },
          newestVersion: { type: 'string', description: 'newest published version' },
          pinnedSpec: { type: 'string', description: 'dependency spec pinned in the root manifest' },
          lastRun: { type: 'json', description: 'previous upgrade record, when present' },
          lastRestart: { type: 'json', description: 'outcome of the last completed restart' },
          selfRestart: { type: 'json', description: 'proof that a requested restart brought this process up' },
        },
      },
      render: (_args, value) => text(
        `install root: ${value.root}`,
        `installed: ${value.installedVersion || '(unknown)'}`,
        `newest published: ${value.newestVersion || '(unknown)'}`,
        `upgrade target: ${value.targetVersion}`,
        `update available: ${value.updateAvailable ? 'yes' : 'no'}`,
        `pinned dependency: ${value.pinnedSpec || '(none)'}`,
        ...(value.lastRestart !== undefined && value.lastRestart !== null
          ? [`last restart: ${value.lastRestart.ok === true ? 'ok' : String(value.lastRestart.reason ?? 'failed')} (${value.lastRestart.mode ?? '?'}) ${value.lastRestart.url ?? ''}`]
          : []),
        ...(value.selfRestart !== undefined && value.selfRestart !== null
          ? [`self restart: confirmed, asked ${value.selfRestart.requestedAt}, up since ${value.selfRestart.processStartedAt}, running ${value.selfRestart.version || '?'}`]
          : []),
      ),
    },
    async execute(args, exec) {
      const root = resolveRoot(args.root);
      const channel = args.channel ?? settings.channel;
      const update = await probe({
        root,
        registry: registryFor(root),
        channel,
        signal: exec?.signal,
      });
      return {
        ...update,
        distTags: update.distTags,
        lastRun: readLastRun(root) ?? null,
        lastRestart: readRestartReport(root),
        selfRestart: readSelfRestart(root),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'dsh_upgrade_apply',
    description:
      'Upgrade this DSH installation to the newest published version: download the tarball, verify '
      + 'its hash, run npm install, re-pin the dependency, then confirm both the manifest and '
      + '`dsh --version` report the new version. Pass dryRun to rehearse without changing anything.',
    parameters: {
      root: { type: 'string', description: 'Install root. Defaults to this process install.' },
      channel: { type: 'string', description: "Version channel (default 'newest')." },
      dryRun: { type: 'boolean', description: 'Rehearse only: npm --dry-run, no pin, no restart.' },
      restart: { type: 'boolean', description: 'Restart the desktop shell afterwards so the new build loads.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          applied: { type: 'boolean', required: true, description: 'whether the version changed' },
          verified: { type: 'boolean', description: 'manifest and CLI agree on the new version' },
          reason: { type: 'string', description: 'why the run ended the way it did' },
          installedVersion: { type: 'string', description: 'version before the run' },
          installedAfter: { type: 'string', description: 'version after the run' },
          targetVersion: { type: 'string', description: 'version that was targeted' },
          cliReported: { type: 'string', description: 'what dsh --version printed' },
          steps: { type: 'json', description: 'per-stage outcome' },
          backupStamp: { type: 'string', description: 'identifier of the manifest backup' },
          restart: { type: 'json', description: 'detached restart outcome, when requested' },
        },
      },
      render: (_args, value) => text(
        `upgrade: ${value.reason ?? ''} (${value.installedVersion || '?'} -> ${value.installedAfter || value.targetVersion || '?'})`,
        `verified: ${value.verified === true ? 'yes' : 'no'}`,
        ...(Array.isArray(value.steps)
          ? value.steps.map((step) => `  ${step.stage}: ${step.status} — ${step.detail}`)
          : []),
        ...(value.restart !== undefined && value.restart !== null
          ? [`restart: ${value.restart.ok === true ? 'scheduled' : 'failed'} — ${value.restart.detail ?? ''}`]
          : []),
      ),
    },
    async execute(args, exec) {
      const root = resolveRoot(args.root);
      const outcome = await applyUpgrade({
        root,
        registry: registryFor(root),
        channel: args.channel ?? settings.channel,
        dryRun: args.dryRun === true,
        signal: exec?.signal,
      });
      const wantsRestart = args.restart === true || (settings.autoRestart === true && outcome.applied === true);
      if (wantsRestart && outcome.applied === true && args.dryRun !== true) {
        const restart = await scheduleRestart(root, {
          delaySeconds: settings.restartDelaySeconds,
        });
        return { ...outcome, restart };
      }
      return outcome;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'dsh_upgrade_verify',
    description:
      'Check that the installation on disk really is the newest published version: compare the '
      + 'manifest, ask a fresh CLI process for --version, and re-verify the pinned tarball hash. '
      + 'Read-only.',
    parameters: {
      root: { type: 'string', description: 'Install root. Defaults to this process install.' },
      channel: { type: 'string', description: "Version channel (default 'newest')." },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          verified: { type: 'boolean', required: true, description: 'everything agrees on the target version' },
          installedVersion: { type: 'string', description: 'version in the manifest' },
          targetVersion: { type: 'string', description: 'newest published version' },
          manifestOk: { type: 'boolean', description: 'manifest matches the target' },
          cliOk: { type: 'boolean', description: 'CLI reports the target version' },
          tarballOk: { type: 'boolean', description: 'pinned tarball hash matches the registry' },
          cliReported: { type: 'string', description: 'raw CLI output' },
          cliDetail: { type: 'string', description: 'how the CLI check ended' },
          tarballDetail: { type: 'string', description: 'how the hash check ended' },
        },
      },
      render: (_args, value) => text(
        `verified: ${value.verified === true ? 'yes' : 'no'}`,
        `manifest: ${value.installedVersion || '(unknown)'} (${value.manifestOk === true ? 'matches' : 'does not match'} ${value.targetVersion})`,
        `cli --version: ${value.cliReported || '(none)'} (${value.cliOk === true ? 'matches' : 'does not match'})`,
        `tarball: ${value.tarballDetail ?? ''}`,
      ),
    },
    async execute(args, exec) {
      const root = resolveRoot(args.root);
      return await verifyInstall({
        root,
        registry: registryFor(root),
        channel: args.channel ?? settings.channel,
        signal: exec?.signal,
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'dsh_upgrade_restart',
    description:
      'Restart the DSH desktop shell so it loads the version now on disk. The restart runs detached '
      + 'through WMI so it survives the shell being stopped (the shell keeps its child in a '
      + 'kill-on-close job object). Optionally report a port to wait for.',
    parameters: {
      root: { type: 'string', description: 'Install root. Defaults to this process install.' },
      port: { type: 'number', description: 'Port the web server should answer on (default 3179).' },
      delaySeconds: { type: 'number', description: 'How long to wait before stopping the host (default 6).' },
      mode: {
        type: 'string',
        description: "How to come back: 'auto' (default: relaunch the desktop shell when one is running, else start the web server detached), 'shell', or 'cli'.",
        enum: ['auto', 'shell', 'cli'],
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'the detached restart was started' },
          scriptPath: { type: 'string', description: 'generated restart script' },
          pid: { type: 'number', description: 'detached process id' },
          method: { type: 'string', description: 'how the script was launched (wmi or schtasks)' },
          detail: { type: 'string', description: 'human-readable outcome' },
          previousRestart: { type: 'json', description: 'evidence from the last completed restart' },
        },
      },
      render: (_args, value) => text(
        `restart: ${value.ok === true ? 'scheduled' : 'failed'}`,
        value.detail ?? '',
        value.method !== undefined ? `launched through: ${value.method}` : '',
        value.scriptPath !== undefined ? `script: ${value.scriptPath}` : '',
        ...(value.previousRestart !== undefined && value.previousRestart !== null
          ? [
            'previous restart:',
            `  mode: ${value.previousRestart.mode ?? '(unknown)'}`,
            `  answered: ${String(value.previousRestart.answered)}`,
            `  url: ${value.previousRestart.url ?? '(none)'}`,
            `  at: ${value.previousRestart.at ?? '(unknown)'}`,
          ]
          : []),
      ),
    },
    async execute(args, exec) {
      const root = resolveRoot(args.root);
      const previousRestart = readRestartReport(root);
      const launched = await scheduleRestart(root, {
        port: args.port ?? 3179,
        delaySeconds: args.delaySeconds ?? settings.restartDelaySeconds,
        mode: args.mode ?? settings.restartMode,
        signal: exec?.signal,
      });
      return { ...launched, previousRestart };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'dsh_upgrade_status_all',
    description:
      'Report the newest published version once, for a machine that keeps several installs. Takes '
      + 'an explicit list of roots; each is reported with the version found there. Read-only.',
    parameters: {
      roots: {
        type: 'array',
        items: { type: 'string', description: 'install root directory' },
        description: 'Install roots to inspect. Defaults to this process install only.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          installs: { type: 'json', required: true, description: 'install root and version pairs' },
          targetVersion: { type: 'string', description: 'newest published version' },
        },
      },
      render: (_args, value) => text(
        `newest published: ${value.targetVersion ?? '(unknown)'}`,
        ...(Array.isArray(value.installs)
          ? value.installs.map((entry) => `${entry.version || '(unknown)'}  ${entry.root}`)
          : []),
      ),
    },
    async execute(args, exec) {
      const root = resolveRoot();
      const registry = registryFor(root);
      const packument = await fetchPackument(PACKAGE_NAME, { registry, signal: exec?.signal });
      const target = pickTargetVersion(packument, settings.channel);
      const requested = Array.isArray(args.roots) && args.roots.length > 0 ? args.roots : [root];
      const installs = [];
      for (const candidate of requested) {
        try {
          const resolved = detectInstallRoot({ explicit: candidate });
          installs.push({ root: resolved, version: installedVersion(resolved) });
        } catch (error) {
          installs.push({ root: candidate, version: '', error: String(error?.message ?? error) });
        }
      }
      return { installs, targetVersion: target };
    },
  }));

  // A slash command is a convenient entry point for a human sitting in the UI.
  const commands = ctx.get('commands');
  if (commands !== undefined && typeof commands.register === 'function') {
    ctx.effect(() => commands.register({
      name: 'upgrade',
      description: 'Check for a newer DSH build and upgrade this installation to it.',
      handler: async (invocation) => {
        const root = resolveRoot();
        try {
          const outcome = await applyUpgrade({
            root,
            registry: registryFor(root),
            channel: settings.channel,
            signal: invocation?.signal,
          });
          if (outcome.applied === true) {
            await scheduleRestart(root, { delaySeconds: settings.restartDelaySeconds });
          }
          const detail = outcome.applied === true
            ? `upgraded ${outcome.installedVersion || '?'} -> ${outcome.installedAfter || '?'} (verified: ${String(outcome.verified)})`
            : `${outcome.reason}: already at ${outcome.installedVersion || '?'}`;
          return { kind: 'success', text: detail };
        } catch (error) {
          return { kind: 'error', text: `upgrade failed: ${String(error?.message ?? error)}` };
        }
      },
    }), 'dsh-upgrade: /upgrade command');
  }
}

/**
 * Read the plugin's own manifest (used by tests and the status tool).
 * @returns {object} parsed package.json.
 */
export function manifest() {
  return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
}
