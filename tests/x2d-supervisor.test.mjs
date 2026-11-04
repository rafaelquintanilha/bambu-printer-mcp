import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { runX2dSupervisor } from '../dist/x2d-supervisor.js';

// A minimal stdio MCP server whose "build" is the text of build.js.
const FAKE_SERVER = `
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
const version = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'build.js'), 'utf8').trim();
let initializes = 0, initialized = 0;
const out = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const pending = new Map();
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') { initializes++; return out({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version } } }); }
  if (m.method === 'notifications/initialized') { initialized++; return; }
  if (m.id !== undefined && m.method === undefined) { pending.get(m.id)?.(m); return; }
  if (m.method !== 'tools/call') return out({ id: m.id, error: { code: -32601, message: 'no' } });
  const reply = text => out({ id: m.id, result: { content: [{ type: 'text', text }] } });
  const name = m.params.name;
  if (name === 'crash') process.exit(3);
  if (name === 'slow') {
    out({ method: 'notifications/message', params: { level: 'info', data: 'slow started' } });
    return setTimeout(() => reply(version), 400);
  }
  if (name === 'ask') {
    pending.set('srv-1', answer => reply(version + ':' + answer.result.action));
    return out({ id: 'srv-1', method: 'elicitation/create', params: { message: 'ok?' } });
  }
  reply(version + ':' + initializes + ':' + initialized + ':' + process.pid);
});
`;

async function harness(t) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'x2d-supervisor-'));
  // Close the session even when an assertion fails, so no fake server outlives its test.
  t.after(() => { input.end(); fs.rmSync(dist, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(dist, 'server.mjs'), FAKE_SERVER);
  fs.writeFileSync(path.join(dist, 'build.js'), 'v1');
  const input = new PassThrough();
  const output = new PassThrough();
  const logs = [];
  const done = runX2dSupervisor({ command: process.execPath, args: [path.join(dist, 'server.mjs')], env: process.env,
    distDirectory: dist, settleMs: 0, input, output, log: message => logs.push(message) });
  const received = [];
  const waiters = [];
  createInterface({ input: output }).on('line', line => {
    const message = JSON.parse(line);
    received.push(message);
    for (const waiter of [...waiters]) if (waiter.match(message)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
  });
  const next = match => {
    const found = received.find(match);
    if (found) { received.splice(received.indexOf(found), 1); return Promise.resolve(found); }
    return new Promise(resolve => waiters.push({ match: m => { if (!match(m)) return false; received.splice(received.indexOf(m), 1); return true; }, resolve }));
  };
  let id = 0;
  const call = async (name) => {
    const requestId = ++id;
    input.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name, arguments: {} } }) + '\n');
    return { id: requestId, reply: next(m => m.id === requestId) };
  };
  const text = async name => (await (await call(name)).reply).result.content[0].text;
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) + '\n');
  assert.equal((await next(m => m.id === 0)).result.serverInfo.version, 'v1');
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const rebuild = version => fs.writeFileSync(path.join(dist, 'build.js'), version);
  return { input, done, logs, call, text, next, rebuild };
}

test('a rebuilt server is loaded on the next request with the handshake replayed', async t => {
  const h = await harness(t);
  const [first, , , firstPid] = (await h.text('version')).split(':');
  assert.equal(first, 'v1');
  h.rebuild('v22');
  const [version, initializes, initialized, pid] = (await h.text('version')).split(':');
  assert.deepEqual([version, initializes, initialized], ['v22', '1', '1'], 'the new server saw one initialize and one initialized');
  assert.notEqual(pid, firstPid);
  assert.equal((await h.text('version')).split(':')[3], pid, 'an unchanged build keeps the same server');
  assert(h.logs.some(line => /loaded the rebuilt server/.test(line)));
  h.input.end();
  assert.equal(await h.done, 0);
});

test('no swap while a request is in flight', async t => {
  const h = await harness(t);
  const slow = await h.call('slow');
  await h.next(m => m.method === 'notifications/message' && m.params.data === 'slow started');
  h.rebuild('v333');
  const during = (await h.text('version')).split(':')[0];
  assert.equal(during, 'v1', 'requests during an open call stay on the running server');
  assert.equal((await slow.reply).result.content[0].text, 'v1');
  assert.equal((await h.text('version')).split(':')[0], 'v333');
  h.input.end();
  await h.done;
});

test('a crashed server is replaced and its open request is reported as uncertain', async t => {
  const h = await harness(t);
  const crash = await h.call('crash');
  const reply = await crash.reply;
  assert.match(reply.error.message, /exited before replying.*check the printer/);
  const [version, initializes, initialized] = (await h.text('version')).split(':');
  assert.deepEqual([version, initializes, initialized], ['v1', '1', '1']);
  h.input.end();
  await h.done;
});

test('server requests reach the client and its answer returns to that server', async t => {
  const h = await harness(t);
  const ask = await h.call('ask');
  const request = await h.next(m => m.method === 'elicitation/create');
  h.rebuild('v4444');
  h.input.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { action: 'accept' } }) + '\n');
  assert.equal((await ask.reply).result.content[0].text, 'v1:accept');
  assert.equal((await h.text('version')).split(':')[0], 'v4444');
  h.input.end();
  await h.done;
});
