#!/usr/bin/env node
// Fake `codex app-server --listen stdio://` for metadata-session tests.
// Behaviour comes from `<this file>.json`; every received line and the argv are
// appended to `<this file>.log` (one JSON object per line) so tests can assert the
// exact methods/params the client sent. No network, no credentials.
import { appendFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const self = process.argv[1];
const config = JSON.parse(readFileSync(`${self}.json`, 'utf8'));
const log = (entry) => appendFileSync(`${self}.log`, `${JSON.stringify(entry)}\n`);
log({ argv: process.argv.slice(2), cwd: process.cwd(), envKeys: Object.keys(process.env).sort() });

if (config.ignoreSigterm) process.on('SIGTERM', () => log({ sigterm: true }));
if (config.grandchild) {
  const child = spawn(process.execPath, [
    '-e',
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
  ], { stdio: 'ignore' });
  log({ grandchildPid: child.pid, pid: process.pid });
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
let accountReads = 0;
let modelListCalls = 0;
let buffer = '';

function respond(message) {
  const { id, method, params } = message;
  if (config.hang?.includes(method)) return;
  if (config.methodNotFound?.includes(method)) {
    send({ id, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  if (method === 'initialize') {
    if (config.serverRequest) send({ id: 'srv-1', method: 'item/tool/requestApproval', params: {} });
    send({ method: 'remoteControl/status/changed', params: {} });
    send({ id, result: { userAgent: 'codex/fixture', codexHome: '/tmp/fixture', platformFamily: 'unix', platformOs: 'macos' } });
    return;
  }
  if (method === 'account/read') {
    // Metadata sessions must never trigger a credential refresh.
    if (params?.refreshToken !== false) {
      send({ id, error: { code: -32000, message: 'refreshToken must be false in metadata sessions' } });
      return;
    }
    accountReads += 1;
    const result = accountReads > 1 && config.accountAfter !== undefined ? config.accountAfter : config.account;
    send({ id, result });
    return;
  }
  if (method === 'model/list') {
    modelListCalls += 1;
    if (config.modelListNotFoundAfterFirst && modelListCalls > 1) {
      send({ id, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    if (config.modelListError) {
      send({ id, error: { code: -32000, message: config.modelListError } });
      return;
    }
    const pages = config.pages ?? [];
    const cursor = params?.cursor ?? null;
    const page = config.loopPages
      ? pages[Math.min(modelListCalls - 1, pages.length - 1)]
      : pages.find((candidate) => (candidate.cursor ?? null) === cursor);
    if (!page) {
      send({ id, error: { code: -32602, message: `unknown cursor ${cursor}` } });
      return;
    }
    if (config.rawModelLine) {
      process.stdout.write(`${config.rawModelLine}\n`);
      return;
    }
    send({ id, result: { data: page.data, nextCursor: page.nextCursor ?? null } });
    return;
  }
  send({ id, error: { code: -32601, message: 'Method not found' } });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    log({ received: message });
    if (message.method && message.id !== undefined) respond(message);
  }
});
process.stdin.on('end', () => {
  if (!config.stayAliveAfterStdinEnd) process.exit(0);
});
setInterval(() => {}, 1_000);
