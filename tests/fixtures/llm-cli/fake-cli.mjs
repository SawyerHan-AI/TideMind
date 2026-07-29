#!/usr/bin/env node
import { basename } from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const name = basename(process.argv[1] ?? '');
const kind = name.includes('claude') ? 'claude' : name.includes('codex') ? 'codex' : 'fake';

if (args.includes('--version')) {
  process.stdout.write(kind === 'claude' ? '2.1.215 (Claude Code)\\n' : 'codex-cli 0.145.0-alpha.18\\n');
  process.exit(0);
}

if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({
    loggedIn: true,
    authMethod: 'oauth',
    apiProvider: 'firstParty',
    email: 'fixture@example.com',
  }));
  process.exit(0);
}

if (args[0] === 'login' && args[1] === 'status') {
  process.stdout.write('Logged in using ChatGPT\\n');
  process.exit(0);
}

let stdin = '';
for await (const chunk of process.stdin) stdin += chunk.toString();

if (stdin.startsWith('SLEEP')) {
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}
if (stdin.startsWith('BIG')) {
  process.stdout.write('x'.repeat(1024 * 1024));
  process.exit(0);
}
if (stdin.startsWith('CORRUPT')) {
  process.stdout.write('{not-json');
  process.exit(0);
}
if (stdin.startsWith('QUOTA')) {
  process.stderr.write('You have insufficient quota');
  process.exit(1);
}
if (stdin.startsWith('GRANDCHILD')) {
  const grandchild = spawn(process.execPath, [
    '-e',
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
  ], { stdio: 'ignore' });
  process.stdout.write(String(grandchild.pid));
  process.exit(0);
}

const inspection = JSON.stringify({
  argv: args,
  cwd: process.cwd(),
  stdin,
  envKeys: Object.keys(process.env).sort(),
});

if (args[0] === 'exec') {
  process.stdout.write(`${JSON.stringify({ type: 'thread.started', model: 'gpt-fixture' })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`);
  if (stdin.startsWith('TOOL')) {
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: { type: 'command_execution', command: 'whoami' },
    })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: inspection },
    })}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    type: 'turn.completed',
    usage: {
      input_tokens: 11,
      cached_input_tokens: 2,
      output_tokens: 7,
      reasoning_tokens: 3,
    },
  })}\n`);
} else {
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: inspection,
    model: 'claude-fixture',
    usage: { input_tokens: 11, cache_read_input_tokens: 2, output_tokens: 7 },
  }));
}
