import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRestartScript,
  clearPendingRestart,
  confirmSelfRestart,
  readPendingRestart,
  readRestartReport,
  readSelfRestart,
  writePendingRestart,
  writeRestartScript,
} from '../lib/restart.js';

/** Create a throwaway install root. */
function stateRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-restart-'));
  mkdirSync(join(root, '.dsh-upgrade'), { recursive: true });
  return root;
}

test('the restart script states are emitted in the safe order', () => {
  const script = buildRestartScript({ shellExe: 'C:\\x\\DshDesktop.exe', port: 4200, delaySeconds: 9 });
  const stopWeb = script.indexOf('stopping web server pid=');
  const stopShell = script.indexOf('stopping shell pid=');
  const relaunch = script.indexOf('shell relaunched');
  assert.ok(stopWeb > 0, 'the web server is stopped');
  assert.ok(stopShell > stopWeb, 'the shell is stopped only after the web server');
  assert.ok(relaunch > stopShell, 'the shell is relaunched last');
});

test('the restart script carries the requested port and delay', () => {
  const script = buildRestartScript({ port: 4200, delaySeconds: 9 });
  assert.match(script, /Start-Sleep -Seconds 9/u);
  assert.match(script, /requestedPort = 4200/u);
});

test('the restart script follows the port the shell actually advertises', () => {
  const script = buildRestartScript({});
  assert.ok(script.includes('ready url='), 'reads the ready line from the shell log');
  assert.ok(script.includes('$url = $found.Groups[1].Value'), 'takes the URL the shell printed');
  // Only the no-shell branch may fall back to the requested port: nothing
  // advertises a URL there, so it is the only thing to wait for.
  const fixedUrl = script.indexOf("$url = 'http://127.0.0.1:3179/'");
  assert.ok(fixedUrl > script.indexOf('web server relaunched detached'), 'the fixed port belongs to the no-shell branch only');
});

test('the restart script only trusts log lines written after the relaunch', () => {
  const script = buildRestartScript({});
  assert.ok(script.includes('$startOffset'), 'remembers where the log ended');
  assert.ok(script.includes('Get-Item -LiteralPath $shellLog).Length'), 'measures the log size');
  assert.ok(!script.includes('-Tail 40'), 'does not scan a fixed tail window');
  assert.ok(script.indexOf('startOffset = (Get-Item') < script.indexOf('shell relaunched'), 'samples the offset before relaunching');
});

test('a rehearsal can leave the real shell running', () => {
  const script = buildRestartScript({ stopShell: false });
  assert.ok(script.includes('A rehearsal leaves the running shell alone'), 'says what it skips');
  assert.ok(!script.includes('stopping shell pid='), 'never stops a shell');
  const production = buildRestartScript({});
  assert.ok(production.includes('stopping shell pid='), 'a real restart stops it');
});

test('the restart script can follow a stand-in shell log', () => {
  const script = buildRestartScript({ shellLogName: 'ProbeShell\\probe.log' });
  assert.ok(script.includes("'ProbeShell\\probe.log'"), 'reads the log it was pointed at');
  const production = buildRestartScript({});
  assert.ok(production.includes("'DshDesktop\\shell.log'"), 'defaults to the real shell log');
});

test('the restart script refuses to run without the shell executable', () => {
  const script = buildRestartScript({ shellExe: 'C:\\missing\\DshDesktop.exe' });
  assert.ok(script.includes("$shellExe = 'C:\\missing\\DshDesktop.exe'"), 'uses the shell path it was given');
  assert.match(script, /Test-Path -LiteralPath \$shellExe/u);
  assert.match(script, /FAILED shell executable is missing/u);
});

test('the restart script matches the web server by its CLI entry point', () => {
  const script = buildRestartScript({});
  assert.ok(script.includes('dsh[\\\\/]lib[\\\\/]bin\\.js'), 'matches bin.js path');
  assert.ok(script.includes('[ \\t]+web(?=[ \\t]|$)'), 'requires the web subcommand right after the entry point');
});

test('a rehearsal can be limited to one port', () => {
  const script = buildRestartScript({ portFilter: 3199 });
  assert.ok(script.includes("--port[ =]3199(\\D|$)"), 'stops only the server on that port');
  const unfiltered = buildRestartScript({});
  assert.ok(!unfiltered.includes('--port[ =]'), 'stops every web server by default');
});

test('a process that merely mentions both words is not a web server', () => {
  // The anchored pattern is what the desktop shell itself uses; a looser one
  // matches any command line that happens to contain both words — including
  // the tool runner that embeds a generated script as text.
  const pattern = /dsh[\\/]lib[\\/]bin\.js"?[ \t]+web(?=[ \t]|$)/u;
  const loose = /dsh[\\/]lib[\\/]bin\.js/u;
  assert.ok(pattern.test('"C:\\Program Files\\nodejs\\node.exe" "C:\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" web --no-open --port 3179'), 'matches the real server');
  assert.ok(pattern.test('node C:\\dsh\\probe\\dsh\\lib\\bin.js web --no-open --port 3199'), 'matches an unquoted invocation');
  const tooling = 'node runner.js -- pwsh -Command "Select-String -Path C:\\dsh\\lib\\bin.js -Pattern web"';
  assert.ok(loose.test(tooling), 'the loose form would have matched tooling');
  assert.ok(!pattern.test(tooling), 'the anchored form does not');
  assert.ok(!pattern.test('node C:\\x\\bin.js worker'), 'does not match another subcommand');
});

test('the restart script writes to the log path it was given', () => {
  const script = buildRestartScript({ logPath: 'C:\\state\\restart.log' });
  assert.ok(script.includes("$log = 'C:\\state\\restart.log'"));
});

test('the default shell path is the desktop install', () => {
  const script = buildRestartScript({});
  assert.ok(script.includes('C:\\dsh\\desktop\\app\\DshDesktop.exe'));
});

test('the restart script writes machine-readable evidence', () => {
  const script = buildRestartScript({ reportPath: 'C:\\state\\last.json' });
  assert.ok(script.includes("$report = 'C:\\state\\last.json'"), 'uses the report path it was given');
  assert.ok(script.includes('ConvertTo-Json'), 'emits JSON');
  assert.ok(script.includes('answered = $answered'), 'records whether the URL answered');
});

test('the restart script can come back without a desktop shell', () => {
  const script = buildRestartScript({ mode: 'cli', nodeExe: 'C:\\node\\node.exe', cliPath: 'C:\\dsh\\bin.js', root: 'C:\\dsh' });
  assert.ok(script.includes("$requestedMode = 'cli'"), 'records the requested mode');
  assert.ok(script.includes('web server relaunched detached'), 'starts the server again itself');
  assert.ok(script.includes("$nodeExe = 'C:\\node\\node.exe'"), 'uses the node binary it was given');
  assert.ok(script.includes("$cliPath = 'C:\\dsh\\bin.js'"), 'uses the CLI entry point it was given');
  assert.ok(script.includes('Start-Detached $nodeExe $installRoot'), 'launches that node binary');
  assert.ok(script.includes("web --no-open --port 3179"), 'passes the web subcommand and port');
});

test('the restart script decides its own mode when asked to', () => {
  const script = buildRestartScript({ mode: 'auto' });
  assert.ok(script.includes("$requestedMode = 'auto'"), 'records auto');
  assert.ok(script.includes("if ($shellProcs.Count -gt 0) { $mode = 'shell' } else { $mode = 'cli' }"), 'prefers the shell, falls back to a detached server');
  assert.ok(script.includes("if ($mode -eq 'shell') {"), 'branches at run time, not at build time');
});

test('the restart script retries a shell that dies on start', () => {
  const script = buildRestartScript({});
  assert.ok(script.includes('for ($attempt = 1; $attempt -le 3; $attempt++) {'), 'relaunches up to three times');
  assert.ok(script.includes('has no ready line yet'), 'reports why it retried');
});

test('the restart script reports the build that came back', () => {
  const script = buildRestartScript({ root: 'C:\\dsh' });
  assert.ok(script.includes("$manifestVersion = ''"), 'reads the manifest version');
  assert.ok(script.includes("$cliVersion = ''"), 'asks the CLI for its version');
  assert.ok(script.includes('manifestVersion = $manifestVersion'), 'puts it in the report');
  assert.ok(script.includes('cliVersion = $cliVersion'), 'puts it in the report');
});

test('a pending restart is recorded before anything is stopped', () => {
  const root = stateRoot();
  writePendingRestart(root, { mode: 'cli', port: 3179, targetVersion: '1.2.3' });
  const pending = readPendingRestart(root);
  assert.equal(pending.mode, 'cli');
  assert.equal(pending.targetVersion, '1.2.3');
  assert.ok(Number.isFinite(Date.parse(pending.requestedAt)), 'records when it was asked for');
});

test('a restart counts as confirmed only for a process that started afterwards', () => {
  const root = stateRoot();
  writePendingRestart(root, { mode: 'shell', requestedAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(confirmSelfRestart(root, { version: '9.9.9' }), null, 'a marker from the future proves nothing');
  assert.notEqual(readPendingRestart(root), null, 'the marker survives an unproven claim');

  writePendingRestart(root, { mode: 'shell', requestedAt: new Date(Date.now() - 60_000).toISOString() });
  const record = confirmSelfRestart(root, { version: '0.2.2-rc.3' });
  assert.ok(record !== null, 'a process started after the request proves the restart');
  assert.equal(record.version, '0.2.2-rc.3');
  assert.equal(record.requestedMode, 'shell');
  assert.ok(record.waitedMs >= 59_000, 'records how long it took');
  assert.equal(readPendingRestart(root), null, 'the marker is consumed');
  assert.deepEqual(readSelfRestart(root), record, 'the proof is on disk');
});

test('a missing pending marker confirms nothing', () => {
  const root = stateRoot();
  assert.equal(confirmSelfRestart(root), null);
  clearPendingRestart(root);
  assert.equal(readPendingRestart(root), null);
});

test('a half-written report reads as absent', () => {
  const root = stateRoot();
  writeFileSync(join(root, '.dsh-upgrade', 'last-restart.json'), '{"ok": tr', 'utf8');
  assert.equal(readRestartReport(root), null);
});

test('the report round-trips through disk', () => {
  const root = stateRoot();
  const record = { ok: true, mode: 'cli', answered: true, url: 'http://127.0.0.1:3179/' };
  writeFileSync(join(root, '.dsh-upgrade', 'last-restart.json'), JSON.stringify(record), 'utf8');
  assert.deepEqual(readRestartReport(root), record);
});

test('the written script lands in the state directory', () => {
  const root = stateRoot();
  const written = writeRestartScript(root, { mode: 'cli' });
  assert.equal(written.path, join(root, '.dsh-upgrade', 'restart.ps1'));
  assert.equal(readFileSync(written.path, 'utf8'), written.content);
  assert.ok(written.content.includes(join(root, '.dsh-upgrade', 'last-restart.json')), 'reports into the same directory');
  assert.ok(written.content.includes(join(root, '.dsh-upgrade', 'restart.log')), 'logs into the same directory');
});
