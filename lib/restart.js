/**
 * Restarting DSH after the files on disk changed.
 *
 * The desktop shell (`DshDesktop.exe`) launches the web server as a child and
 * places it in a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_CLOSE`; the job
 * carries no breakaway flag, so an ordinary child cannot outlive it and cannot
 * escape it. Anything that restarts the host must therefore run *outside* that
 * job or it kills itself halfway through.
 *
 * `Win32_Process.Create` (WMI) is used as the escape hatch: the process it
 * creates is owned by `WmiPrvSE`, never enters the job, and survives the host
 * exiting. A scheduled task is kept as a second escape hatch.
 *
 * Two ways back up are supported, chosen at run time:
 *
 * - `shell` — stop the web server, stop the desktop shell, relaunch the shell.
 *   This is what a double-click user has; it also recreates the window.
 * - `cli` — stop the web server and start it again detached. This is for a
 *   host that was started from a terminal (`dsh web`), where there is no
 *   shell to relaunch.
 *
 * @module dsh-upgrade/restart
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI_RELATIVE_PATH } from './install.js';
import { runCommand } from './npm.js';

/** Conventional home of the desktop shell executable. */
export const DEFAULT_SHELL_EXE = 'C:\\dsh\\desktop\\app\\DshDesktop.exe';

/** Where the detached script records what it did. */
const REPORT_FILE = 'last-restart.json';

/** Marker written before the host is stopped, consumed by the next process. */
const PENDING_FILE = 'pending-restart.json';

/** Evidence that a restart triggered by this plugin actually completed. */
const SELF_RESTART_FILE = 'self-restart.json';

/**
 * Escape a value for a single-quoted PowerShell string.
 * @param {string} value - raw text.
 * @returns {string} escaped text.
 */
function psString(value) {
  return String(value).replace(/'/gu, "''");
}

/**
 * Build the PowerShell script that performs a detach-safe restart.
 *
 * It runs outside the host's job, so it must do the killing itself: web server
 * first, then the shell (when there is one), then relaunch and wait for the URL
 * to answer. Everything it learns is written to a JSON report, because the
 * process that asked for the restart is usually gone by then.
 *
 * @param {object} options - `{ mode, shellExe, nodeExe, cliPath, appArgs, root, port, delaySeconds, logPath, reportPath, pendingPath }`.
 * @returns {string} PowerShell source.
 */
export function buildRestartScript(options = {}) {
  const mode = options.mode ?? 'auto';
  const shellExe = options.shellExe ?? DEFAULT_SHELL_EXE;
  const port = options.port ?? 3179;
  const delaySeconds = options.delaySeconds ?? 6;
  const root = options.root ?? 'C:\\dsh';
  const nodeExe = options.nodeExe ?? 'C:\\Program Files\\nodejs\\node.exe';
  const cliPath = options.cliPath ?? join(root, CLI_RELATIVE_PATH);
  const manifestPath = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  const appArgs = options.appArgs ?? `web --no-open --port ${String(port)}`;
  // A port filter keeps a rehearsal from touching the instance the caller runs
  // in: the script then stops only the server listening on that port.
  const portFilter = options.portFilter ?? null;
  // Rehearsals point the script at a stand-in shell and keep the real one
  // running; production runs always stop it.
  const stopShell = options.stopShell !== false;
  const shellLogName = options.shellLogName ?? 'DshDesktop\\shell.log';
  const shellLogPath = options.shellLogPath ?? null;
  const shellProcessName = options.shellProcessName ?? 'DshDesktop.exe';
  const logPath = options.logPath ?? 'C:\\dsh\\.dsh-upgrade\\restart.log';
  const reportPath = options.reportPath ?? 'C:\\dsh\\.dsh-upgrade\\last-restart.json';
  const pendingPath = options.pendingPath ?? 'C:\\dsh\\.dsh-upgrade\\pending-restart.json';
  // A cold desktop shell needs ~15s to open its window and write the ready line;
  // waiting on a fixed attempt count instead of a deadline gave up after 12s and
  // reported a successful restart as a failure.
  const readyTimeoutSeconds = options.readyTimeoutSeconds ?? 120;
  const lines = [
    '$ErrorActionPreference = \'Continue\'',
    `$log = '${psString(logPath)}'`,
    `$report = '${psString(reportPath)}'`,
    `$pending = '${psString(pendingPath)}'`,
    `$requestedMode = '${psString(mode)}'`,
    `$shellExe = '${psString(shellExe)}'`,
    `$nodeExe = '${psString(nodeExe)}'`,
    `$cliPath = '${psString(cliPath)}'`,
    `$appArgs = '${psString(appArgs)}'`,
    `$installRoot = '${psString(root)}'`,
    'function Note([string]$text) {',
    '  $line = (Get-Date).ToString(\'yyyy-MM-dd HH:mm:ss.fff\') + \'  \' + $text',
    '  Add-Content -LiteralPath $log -Value $line -Encoding UTF8',
    '}',
    'function Save-Report([bool]$ok, [string]$reason, [hashtable]$extra) {',
    '  $record = [ordered]@{',
    '    ok = $ok',
    '    reason = $reason',
    '    mode = $mode',
    '    url = $url',
    '    answered = $answered',
    `    requestedPort = ${port}`,
    '    stoppedWeb = @($stoppedWeb)',
    '    stoppedShell = @($stoppedShell)',
    '    startedWeb = $startedWeb',
    '    startedShell = $startedShell',
    '    cliVersion = $cliVersion',
    '    manifestVersion = $manifestVersion',
    '    startedAt = $marker.ToUniversalTime().ToString(\'o\')',
    '    at = (Get-Date).ToUniversalTime().ToString(\'o\')',
    '  }',
    '  if ($extra) { foreach ($key in $extra.Keys) { $record[$key] = $extra[$key] } }',
    '  Set-Content -LiteralPath $report -Encoding UTF8 -Value ($record | ConvertTo-Json -Compress)',
    '  Note (\'restart: report written to \' + $report)',
    '}',
    'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null',
    '# Start a program so that it outlives this script. `Start-Process` is not',
    '# reliable here: this script runs outside a console, and launching a console',
    '# program from that context can block forever. WMI creation is instant and',
    '# returns the new pid; `cmd /c start` is the fallback.',
    'function Start-Detached([string]$exe, [string]$workdir, [string]$arguments) {',
    '  $commandLine = \'"\' + $exe + \'"\'',
    '  if ($arguments) { $commandLine = $commandLine + \' \' + $arguments }',
    '  try {',
    '    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{',
    '      CommandLine = $commandLine',
    '      CurrentDirectory = $workdir',
    '    }',
    '    if ($created.ReturnValue -eq 0 -and $created.ProcessId -gt 0) {',
    '      Note (\'restart: started pid=\' + $created.ProcessId + \' \' + $exe)',
    '      return $created.ProcessId',
    '    }',
    '    Note (\'restart: WMI create returned \' + $created.ReturnValue)',
    '  } catch {',
    '    Note (\'restart: WMI create failed: \' + $_.Exception.Message)',
    '  }',
    '  Start-Process -FilePath $env:ComSpec -ArgumentList (\'/c start "" "\' + $exe + \'" \' + $arguments) -WorkingDirectory $workdir -WindowStyle Hidden',
    '  Note (\'restart: started through cmd start \' + $exe)',
    '  return 0',
    '}',

    '$marker = Get-Date',
    '$url = $null',
    '$answered = $false',
    '$mode = $requestedMode',
    '$stoppedWeb = @()',
    '$stoppedShell = @()',
    '$startedWeb = 0',
    '$startedShell = 0',
    `Note 'restart: scheduled, waiting ${delaySeconds}s for the caller to return'`,
    `Start-Sleep -Seconds ${delaySeconds}`,
    '',
    '# 0. Resolve the mode: relaunch the shell when one is running, otherwise',
    '#    start the web server again detached.',
    `$shellProcs = @(Get-CimInstance Win32_Process -Filter "Name = '${psString(shellProcessName)}'")`,
    'if ($mode -eq \'auto\') {',
    '  if ($shellProcs.Count -gt 0) { $mode = \'shell\' } else { $mode = \'cli\' }',
    '}',
    'Note (\'restart: mode=\' + $mode)',
    'if ($mode -eq \'shell\' -and -not (Test-Path -LiteralPath $shellExe)) {',
    '  Note \'restart: FAILED shell executable is missing\'',
    '  Save-Report $false \'shell-executable-missing\' $null',
    '  exit 1',
    '}',
    '',
    '# 1. Stop every web server process, oldest first.',
    '#    The pattern is the one the desktop shell itself uses to recognise its',
    '#    own child: the CLI entry point must be followed by the `web`',
    '#    subcommand, so a shell that merely mentions both in its command line',
    '#    (an editor, a grep, another tool runner) is never mistaken for one.',
    '$web = Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'" |',
    `  Where-Object { $_.CommandLine -match 'dsh[\\\\/]lib[\\\\/]bin\\.js"?[ \\t]+web(?=[ \\t]|$)'${portFilter === null ? '' : ` -and $_.CommandLine -match '--port[ =]${String(portFilter)}(\\D|$)'` } }`,
    'foreach ($proc in $web) {',
    '  Note ("restart: stopping web server pid=" + $proc.ProcessId)',
    '  $stoppedWeb += $proc.ProcessId',
    '  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue',
    '}',
    'Start-Sleep -Seconds 2',
    '',
    'if ($mode -eq \'shell\') {',
    stopShell
      ? '  # 2. Stop the shell so its Job cannot take the new server down with it.'
      : '  # 2. A rehearsal leaves the running shell alone; only the stand-in is started.',
    ...(stopShell
      ? [
        '  foreach ($proc in $shellProcs) {',
        '    Note ("restart: stopping shell pid=" + $proc.ProcessId)',
        '    $stoppedShell += $proc.ProcessId',
        '    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue',
        '  }',
        '  Start-Sleep -Seconds 3',
      ]
      : []),
    '',
    '  # 3. Relaunch the shell; it recreates its own web server child.',
    `  $shellLog = Join-Path $env:LOCALAPPDATA '${psString(shellLogName)}'`,
    ...(shellLogPath === null ? [] : [`  $shellLog = '${psString(shellLogPath)}'`]),
    '  # Remember where the log ends: only lines appended from now on can be the',
    '  # ready line of the shell we are about to start. The log already holds',
    '  # millions of heartbeat lines, so a fixed tail window is not reliable.',
    '  $startOffset = 0',
    '  if (Test-Path -LiteralPath $shellLog) { $startOffset = (Get-Item -LiteralPath $shellLog).Length }',
    '  $shellPid = 0',
    '  $launchCount = 0',
    '  $found = $null',
    `  $readyDeadline = (Get-Date).AddSeconds(${readyTimeoutSeconds})`,
    '  while ((Get-Date) -lt $readyDeadline) {',
    '    # A real shell takes far longer to open WebView2 than a stand-in does, and',
    '    # the desktop shell is single-instance: launching again while the first one',
    '    # is still booting only produces a process that exits at once. Relaunch only',
    '    # when nothing we started is alive any more.',
    '    $alive = $shellPid -gt 0 -and [bool](Get-Process -Id $shellPid -ErrorAction SilentlyContinue)',
    '    if (-not $alive -and $launchCount -lt 3) {',
    '      $shellPid = Start-Detached $shellExe (Split-Path -Parent $shellExe) \'\'',
    '      $launchCount++',
    '      Note \'restart: shell relaunched\'',
    '    } elseif (-not $alive) {',
    '      Note \'restart: every launch exited without a ready line\'',
    '      break',
    '    }',
    '    Start-Sleep -Seconds 2',
    '    if (-not (Test-Path -LiteralPath $shellLog)) { continue }',
    '    $length = (Get-Item -LiteralPath $shellLog).Length',
    '    if ($length -le $startOffset) { continue }',
    '    $chunk = \'\'',
    '    $stream = $null',
    '    try {',
    '      $stream = [System.IO.File]::Open($shellLog, \'Open\', \'Read\', \'ReadWrite\')',
    '      $stream.Seek($startOffset, \'Begin\') | Out-Null',
    '      $buffer = New-Object byte[] ($length - $startOffset)',
    '      $read = $stream.Read($buffer, 0, $buffer.Length)',
    '      $chunk = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)',
    '    } catch {',
    '      # The shell holds the log briefly while appending; retry on the next tick.',
    '    } finally {',
    '      if ($stream) { $stream.Close() }',
    '    }',
    '    $found = [regex]::Match($chunk, \'ready url=(http\\S+)\')',
    '    if ($found.Success) { $url = $found.Groups[1].Value; $startedShell = 1; break }',
    '  }',
    '  if (-not ($found -and $found.Success)) { Note \'restart: no ready line before the deadline\' }',
    '  # The ready line is a convenience, not the goal. If the shell we started is',
    '  # alive and something already answers on the port it was given, that is a',
    '  # successful restart even when the log never showed the line.',
    '  if (-not $url -and $shellPid -gt 0 -and (Get-Process -Id $shellPid -ErrorAction SilentlyContinue)) {',
    `    $url = 'http://127.0.0.1:${port}/'`,
    '    $startedShell = 1',
    '    Note (\'restart: shell alive, probing \' + $url + \' without a ready line\')',
    '  }',
    '} else {',
    '  # 2b. No shell: start the web server again, detached from this script.',
    `  $startedWeb = 1`,
    `  $null = Start-Detached $nodeExe $installRoot ('"' + $cliPath + '" ' + $appArgs)`,
    `  Note 'restart: web server relaunched detached'`,
    `  $url = 'http://127.0.0.1:${port}/'`,
    '  Start-Sleep -Seconds 3',
    '}',
    '',
    '# 4. Confirm the advertised URL actually answers.',
    '$deadline = (Get-Date).AddSeconds(120)',
    'while ($url -and (Get-Date) -lt $deadline) {',
    '  try {',
    '    $probe = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3',
    '    if ($probe.StatusCode -ge 200 -and $probe.StatusCode -lt 500) { $answered = $true; break }',
    '  } catch {',
    '    # Not listening yet — keep waiting.',
    '  }',
    '  Start-Sleep -Seconds 2',
    '}',
    `Note ('restart: answered=' + $answered)`,
    'if ($url) { Note (\'restart: serving \' + $url) }',
    '',
    '# 5. Record which build is now on disk and what the CLI says about itself.',
    `$manifestVersion = ''`,
    `if (Test-Path -LiteralPath '${psString(manifestPath)}') {`,
    `  try { $manifestVersion = (Get-Content -LiteralPath '${psString(manifestPath)}' -Raw | ConvertFrom-Json).version } catch { }`,
    '}',
    `$cliVersion = ''`,
    `if (Test-Path -LiteralPath '${psString(cliPath)}') {`,
    `  try { $cliVersion = (& '${psString(nodeExe)}' '${psString(cliPath)}' --version 2>$null | Select-Object -Last 1) } catch { }`,
    '}',
    `Note ('restart: manifest=' + $manifestVersion + ' cli=' + $cliVersion)`,
    '',
    '# 6. Leave machine-readable evidence for the next verification pass.',
    `if ($url -and -not $answered) { Note 'restart: FAILED host did not answer' }`,
    `Save-Report ($answered -and [bool]$url) 'completed' $null`,
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
    root,
    logPath: join(directory, 'restart.log'),
    reportPath: join(directory, REPORT_FILE),
    pendingPath: join(directory, PENDING_FILE),
    ...options,
  });
  writeFileSync(path, content, 'utf8');
  return { path, content };
}

/**
 * Mark a restart as requested, before anything is stopped.
 *
 * The next process compares its own start time against this instant; that is
 * the only way to tell "the restart I asked for is what brought me up" apart
 * from "the user opened the window themselves".
 *
 * @param {string} root - install root.
 * @param {object} info - what was asked for.
 * @returns {string} the marker path.
 */
export function writePendingRestart(root, info) {
  const directory = join(root, '.dsh-upgrade');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, PENDING_FILE);
  writeFileSync(path, `${JSON.stringify({ requestedAt: new Date().toISOString(), ...info }, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * Read the pending restart marker, if any.
 * @param {string} root - install root.
 * @returns {object|null} the marker.
 */
export function readPendingRestart(root) {
  return readJson(join(root, '.dsh-upgrade', PENDING_FILE));
}

/**
 * Drop the pending marker.
 * @param {string} root - install root.
 * @returns {void}
 */
export function clearPendingRestart(root) {
  const path = join(root, '.dsh-upgrade', PENDING_FILE);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // A locked marker only means the next process reports it again.
    }
  }
}

/**
 * Record that a requested restart really did bring this process up.
 * @param {string} root - install root.
 * @param {object} record - evidence.
 * @returns {string} the evidence path.
 */
export function writeSelfRestart(root, record) {
  const directory = join(root, '.dsh-upgrade');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, SELF_RESTART_FILE);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * Read the evidence left by a completed self-restart.
 * @param {string} root - install root.
 * @returns {object|null} the evidence.
 */
export function readSelfRestart(root) {
  return readJson(join(root, '.dsh-upgrade', SELF_RESTART_FILE));
}

/**
 * Approximate the moment this process started.
 * @returns {number} epoch milliseconds.
 */
export function processStartedAt() {
  return Date.now() - Math.round(process.uptime() * 1000);
}

/**
 * Consume a pending restart marker when this process is its result.
 *
 * Called while the plugin loads: if a restart was requested before this
 * process started, the restart worked, and the proof is written to disk.
 *
 * @param {string} root - install root.
 * @param {object} [details] - `{ version, mode }` to attach.
 * @returns {object|null} the self-restart record when one was confirmed.
 */
export function confirmSelfRestart(root, details = {}) {
  const pending = readPendingRestart(root);
  if (pending === null) return null;
  const requestedAt = Date.parse(String(pending.requestedAt ?? ''));
  if (!Number.isFinite(requestedAt)) return null;
  const startedAt = processStartedAt();
  if (startedAt <= requestedAt) return null;
  const record = {
    ok: true,
    requestedAt: new Date(requestedAt).toISOString(),
    processStartedAt: new Date(startedAt).toISOString(),
    waitedMs: startedAt - requestedAt,
    requestedMode: pending.mode ?? 'auto',
    version: details.version ?? '',
    at: new Date().toISOString(),
  };
  writeSelfRestart(root, record);
  clearPendingRestart(root);
  return record;
}

/**
 * Launch the restart script outside the host's Job Object.
 *
 * `Invoke-CimMethod Win32_Process Create` hands the process to `WmiPrvSE.exe`,
 * which is not in the job, so the script survives the host being killed. When
 * WMI is unavailable the same command is registered as a one-shot scheduled
 * task, which also runs outside the job.
 *
 * @param {string} scriptPath - the PowerShell script to run detached.
 * @param {object} [options] - `{ signal }`.
 * @returns {Promise<{ok: boolean, pid?: number, method?: string, detail: string}>} launch result.
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
  if (result.code === 0 && match !== null) {
    const returnValue = Number.parseInt(match[1], 10);
    const pid = Number.parseInt(match[2], 10);
    if (returnValue === 0 && pid !== 0) {
      return { ok: true, pid, method: 'wmi', detail: `detached restart process started (pid ${String(pid)}, shell=${shell})` };
    }
    if (returnValue !== 0) {
      // Fall through to the scheduled-task escape hatch.
    }
  }
  const fallback = await launchThroughScheduledTask(scriptPath, options);
  if (fallback.ok) return fallback;
  const detail = (result.stderr || result.stdout).trim().slice(0, 400);
  return {
    ok: false,
    detail: `WMI launch failed (exit ${String(result.code)}: ${detail}); scheduled task failed too (${fallback.detail})`,
  };
}

/**
 * Register and immediately run the restart script as a one-shot task.
 * @param {string} scriptPath - script to run.
 * @param {object} [options] - `{ signal }`.
 * @returns {Promise<{ok: boolean, method?: string, detail: string}>} launch result.
 */
async function launchThroughScheduledTask(scriptPath, options = {}) {
  const taskName = `DshUpgradeRestart-${Date.now().toString(36)}`;
  const action = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
  const create = await runCommand('schtasks.exe', ['/Create', '/TN', taskName, '/TR', action, '/SC', 'ONCE', '/ST', '23:59', '/F'], {
    signal: options.signal,
    timeoutMs: 60_000,
    cwd: process.env.SystemRoot ?? 'C:\\Windows',
  });
  if (create.code !== 0) {
    return { ok: false, detail: `schtasks /Create exited ${String(create.code)}: ${create.stderr.trim().slice(0, 200)}` };
  }
  const run = await runCommand('schtasks.exe', ['/Run', '/TN', taskName], {
    signal: options.signal,
    timeoutMs: 60_000,
    cwd: process.env.SystemRoot ?? 'C:\\Windows',
  });
  await runCommand('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], {
    signal: options.signal,
    timeoutMs: 30_000,
    cwd: process.env.SystemRoot ?? 'C:\\Windows',
  }).catch(() => undefined);
  if (run.code !== 0) {
    return { ok: false, detail: `schtasks /Run exited ${String(run.code)}: ${run.stderr.trim().slice(0, 200)}` };
  }
  return { ok: true, method: 'schtasks', detail: `detached restart started through scheduled task ${taskName}` };
}

/**
 * Convenience wrapper: write the script, mark it pending, launch it detached.
 * @param {string} root - install root.
 * @param {object} [options] - forwarded to the script builder.
 * @returns {Promise<{ok: boolean, scriptPath: string, pid?: number, detail: string}>} result.
 */
export async function scheduleRestart(root, options = {}) {
  const written = writeRestartScript(root, options);
  writePendingRestart(root, {
    mode: options.mode ?? 'auto',
    port: options.port ?? 3179,
    scriptPath: written.path,
    targetVersion: options.targetVersion ?? '',
  });
  const launched = await launchDetached(written.path, options);
  if (!launched.ok) clearPendingRestart(root);
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
  return readJson(join(root, '.dsh-upgrade', REPORT_FILE));
}

/**
 * Read and parse a JSON file, tolerating a missing or half-written one.
 * @param {string} path - absolute path.
 * @returns {object|null} parsed content.
 */
function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
