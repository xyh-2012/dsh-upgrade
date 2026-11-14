import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRestartScript } from '../lib/restart.js';

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
  assert.ok(!script.includes("http://127.0.0.1:3179/"), 'does not keep insisting on the requested port');
});

test('the restart script refuses to run without the shell executable', () => {
  const script = buildRestartScript({ shellExe: 'C:\\missing\\DshDesktop.exe' });
  assert.match(script, /Test-Path -LiteralPath 'C:\\missing\\DshDesktop\.exe'/u);
  assert.match(script, /FAILED shell executable is missing/u);
});

test('the restart script matches the web server by its CLI entry point', () => {
  const script = buildRestartScript({});
  assert.ok(script.includes('dsh[\\\\/]lib[\\\\/]bin\\.js'), 'matches bin.js path');
  assert.ok(script.includes('\\bweb\\b'), 'matches the web subcommand');
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
