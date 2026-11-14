/**
 * Restarting the desktop shell after the files on disk changed.
 *
 * The shell (`DshDesktop.exe`) launches the web server as a child and places
 * it in a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_CLOSE`; the job carries no
 * breakaway flag, so an ordinary child cannot outlive it and cannot escape it.
 * Anything that restarts the shell must therefore run *outside* that job or it
 * kills itself halfway through.
 *
 * `Win32_Process.Create` (WMI) is used as the escape hatch: the process it
 * creates is owned by `WmiPrvSE`, never enters the job, and survives the shell
 * exiting.
 *
 * @module dsh-upgrade/restart
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from './npm.js';

/** Conventional home of the desktop shell executable. */
export const DEFAULT_SHELL_EXE = 'C:\\dsh\\desktop\\app\\DshDesktop.exe';

/**
 * Build the PowerShell script that performs a detach-safe restart.
 *
 * It runs outside the shell's job, so it must do the killing itself: web
 * server first, then the shell, then relaunch and wait for the URL to answer.
 *
 * @param {object} options - `{ shellExe, port, delaySeconds, logPath }`.
 * @returns {string} PowerShell source.
 */
export function buildRestartScript(options = {}) {
  const shellExe = options.shellExe ?? DEFAULT_SHELL_EXE;
  const port = options.port ?? 3179;
  const delaySeconds = options.delaySeconds ?? 6;
  const logPath = options.logPath ?? 'C:\\dsh\\.dsh-upgrade\\restart.log';
  const reportPath = options.reportPath ?? 'C:\\dsh\\.dsh-upgrade\\last-restart.json';
  const lines = [
    '$ErrorActionPreference = \'Continue\'',
    `$log = '${logPath}'`,
    `$report = '${reportPath}'`,
    'function Note([string]$text) {',
    '  $line = (Get-Date).ToString(\'yyyy-MM-dd HH:mm:ss.fff\') + \'  \' + $text',
    '  Add-Content -LiteralPath $log -Value $line -Encoding UTF8',
    '}',
    'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null',
    `Note 'restart: scheduled, waiting ${delaySeconds}s for the caller to return'`,
    `Start-Sleep -Seconds ${delaySeconds}`,
    '',
    '# 1. Stop every web server process, oldest first.',
    '$stoppedWeb = @()',
    '$web = Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'" |',
    '  Where-Object { $_.CommandLine -match \'dsh[\\\\/]lib[\\\\/]bin\\.js\' -and $_.CommandLine -match \'\\bweb\\b\' }',
    'foreach ($proc in $web) {',
    '  Note ("restart: stopping web server pid=" + $proc.ProcessId)',
    '  $stoppedWeb += $proc.ProcessId',
    '  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue',
    '}',
    'Start-Sleep -Seconds 2',
    '',
    '# 2. Stop the shell so its Job cannot take the new server down with it.',
    '$stoppedShell = @()',
    `$shell = Get-CimInstance Win32_Process -Filter "Name = 'DshDesktop.exe'"`,
    'foreach ($proc in $shell) {',
    '  Note ("restart: stopping shell pid=" + $proc.ProcessId)',
    '  $stoppedShell += $proc.ProcessId',
    '  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue',
    '}',
    'Start-Sleep -Seconds 3',
    '',
    '# 3. Relaunch the shell; it recreates its own web server child.',
    `if (-not (Test-Path -LiteralPath '${shellExe}')) {`,
    `  Note 'restart: FAILED shell executable is missing'`,
    `  Set-Content -LiteralPath $report -Encoding UTF8 -Value ('{"ok":false,"reason":"shell-executable-missing","at":"' + (Get-Date).ToUniversalTime().ToString('o') + '"}')`,
    '  exit 1',
    '}',
    `$shellLog = Join-Path $env:LOCALAPPDATA 'DshDesktop\\shell.log'`,
    '$marker = Get-Date',
    '# Remember where the log ends: only lines appended from now on can be the',
    '# ready line of the shell we are about to start. The log already holds',
    '# millions of heartbeat lines, so a fixed tail window is not reliable.',
    '$startOffset = 0',
    'if (Test-Path -LiteralPath $shellLog) { $startOffset = (Get-Item -LiteralPath $shellLog).Length }',
    `Start-Process -FilePath '${shellExe}' -WorkingDirectory (Split-Path -Parent '${shellExe}')`,
    `Note 'restart: shell relaunched'`,
    '',
    '# 4. The shell picks its own free port, so read the real URL it advertises.',
    '$url = $null',
    '$deadline = (Get-Date).AddSeconds(120)',
    'while ((Get-Date) -lt $deadline) {',
    '  Start-Sleep -Seconds 2',
    '  if (-not (Test-Path -LiteralPath $shellLog)) { continue }',
    '  $length = (Get-Item -LiteralPath $shellLog).Length',
    '  if ($length -le $startOffset) { continue }',
    '  $chunk = \'\'',
    '  $stream = $null',
    '  try {',
    '    $stream = [System.IO.File]::Open($shellLog, \'Open\', \'Read\', \'ReadWrite\')',
    '    $stream.Seek($startOffset, \'Begin\') | Out-Null',
    '    $buffer = New-Object byte[] ($length - $startOffset)',
    '    $read = $stream.Read($buffer, 0, $buffer.Length)',
    '    $chunk = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)',
    '  } catch {',
    '    # The shell holds the log briefly while appending; retry on the next tick.',
    '  } finally {',
    '    if ($stream) { $stream.Close() }',
    '  }',
    '  $found = [regex]::Match($chunk, \'ready url=(http\\S+)\')',
    '  if ($found.Success) { $url = $found.Groups[1].Value; break }',
    '}',
    'if (-not $url) {',
    `  Note 'restart: FAILED no ready url in the shell log'`,
    `  Set-Content -LiteralPath $report -Encoding UTF8 -Value ('{"ok":false,"reason":"no-ready-url","at":"' + (Get-Date).ToUniversalTime().ToString('o') + '"}')`,
    '  exit 1',
    '}',
    `Note ('restart: shell advertises ' + $url)`,
    '',
    '# 5. Confirm the advertised URL actually answers.',
    '$answered = $false',
    'for ($i = 0; $i -lt 30; $i++) {',
    '  try {',
    '    $probe = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3',
    '    if ($probe.StatusCode -ge 200 -and $probe.StatusCode -lt 500) { $answered = $true; break }',
    '  } catch {',
    '    # Not listening yet — keep waiting.',
    '  }',
    '  Start-Sleep -Seconds 2',
    '}',
    `Note ('restart: answered=' + $answered)`,
    '',
    '# 6. Leave machine-readable evidence for the next verification pass.',
    '$record = [ordered]@{',
    '  ok = $answered',
    '  url = $url',
    '  answered = $answered',
    `  requestedPort = ${port}`,
    '  stoppedWeb = @($stoppedWeb)',
    '  stoppedShell = @($stoppedShell)',
    '  startedAt = $marker.ToUniversalTime().ToString(\'o\')',
    '  at = (Get-Date).ToUniversalTime().ToString(\'o\')',
    '}',
    'Set-Content -LiteralPath $report -Encoding UTF8 -Value ($record | ConvertTo-Json -Compress)',
    'Note \'restart: done\'',
  ];
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Write the restart script into the install root's state directory.
 * @param {string} root - install root.
 * @param {object} [options] - forwarded to {@link buildRestartScript}.
 * @returns {{path: string, content: string}} where it landed.
 */
export function writeRestartScript(root, options = {}) {
  const directory = join(root, '.dsh-upgrade');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'restart.ps1');
  const content = buildRestartScript({
    logPath: join(directory, 'restart.log'),
    reportPath: join(directory, 'last-restart.json'),
    ...options,
  });
  writeFileSync(path, content, 'utf8');
  return { path, content };
}

/**
 * Launch the restart script outside the shell's Job Object.
 *
 * `Invoke-CimMethod Win32_Process Create` hands the process to `WmiPrvSE.exe`,
 * which is not in the job, so the script survives the shell being killed.
 *
 * @param {string} scriptPath - the PowerShell script to run detached.
 * @param {object} [options] - `{ signal }`.
 * @returns {Promise<{ok: boolean, pid?: number, detail: string}>} launch result.
 */
export async function launchDetached(scriptPath, options = {}) {
  if (!existsSync(scriptPath)) {
    return { ok: false, detail: `restart script not found: ${scriptPath}` };
  }
  const commandLine = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
  const escaped = commandLine.replace(/'/gu, "''");
  const script = [
    `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${escaped}' }`,
    'Write-Output ("returnValue=" + $result.ReturnValue + " pid=" + $result.ProcessId)',
  ].join('; ');
  const shell = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';
  const result = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    signal: options.signal,
    timeoutMs: 60_000,
    cwd: process.env.SystemRoot ?? 'C:\\Windows',
  });
  const match = /returnValue=(\d+)\s+pid=(\d+)/u.exec(result.stdout);
  if (result.code !== 0 || match === null) {
    return {
      ok: false,
      detail: `WMI launch failed (exit ${String(result.code)}): ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
    };
  }
  const returnValue = Number.parseInt(match[1], 10);
  const pid = Number.parseInt(match[2], 10);
  if (returnValue !== 0 || pid === 0) {
    return { ok: false, pid, detail: `Win32_Process.Create returned ${String(returnValue)}` };
  }
  return { ok: true, pid, detail: `detached restart process started (pid ${String(pid)}, shell=${shell})` };
}

/**
 * Convenience wrapper: write the script and launch it detached.
 * @param {string} root - install root.
 * @param {object} [options] - forwarded to the script builder.
 * @returns {Promise<{ok: boolean, scriptPath: string, pid?: number, detail: string}>} result.
 */
export async function scheduleRestart(root, options = {}) {
  const written = writeRestartScript(root, options);
  const launched = await launchDetached(written.path, options);
  return { ...launched, scriptPath: written.path };
}

/**
 * Read the evidence the last detached restart left behind.
 *
 * The restart runs after this process may already be gone, so the only way to
 * report on it later is the JSON record it writes when it finishes.
 *
 * @param {string} root - install root.
 * @returns {object|null} the record, or null when no restart has completed.
 */
export function readRestartReport(root) {
  const path = join(root, '.dsh-upgrade', 'last-restart.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
