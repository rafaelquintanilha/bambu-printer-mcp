import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { listInternalPrinterFiles, uploadInternalPrinterFile } from '../dist/bambu-file-service.js';

const fixture = new URL('./fixtures/file-service.mjs', import.meta.url).href;
async function setup(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bambu-file-service-'));
  const executable = path.join(directory, 'helper.mjs');
  const eventsFile = path.join(directory, 'events.jsonl');
  const filePath = path.join(directory, 'snapshot.3mf');
  const bytes = Buffer.from(Array.from({ length: 5031 }, (_, index) => index % 256));
  await fs.writeFile(filePath, bytes);
  await fs.writeFile(eventsFile, '');
  await fs.writeFile(executable, `#!/usr/bin/env node
import {runFakeFileService} from ${JSON.stringify(fixture)};
if(process.argv[2]!=='--file-service') throw new Error('Print/control mode requested');
await runFakeFileService(${JSON.stringify({ eventsFile, ...options })});
`, { mode: 0o755 });
  const previous = process.env.BAMBU_NATIVE_HELPER;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  process.env.BAMBU_NATIVE_HELPER = executable;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  t.after(async () => {
    Object.defineProperty(process, 'platform', platform);
    if (previous === undefined) delete process.env.BAMBU_NATIVE_HELPER;
    else process.env.BAMBU_NATIVE_HELPER = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { connection: { host: '127.0.0.1', token: 'DUMMY', filePath, remoteName: 'checked-unique.3mf' }, bytes,
    events: async () => (await fs.readFile(eventsFile, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) };
}

test('internal upload reads back all bytes and checks both checksums without print commands', async t => {
  const s = await setup(t);
  const result = await uploadInternalPrinterFile(s.connection);
  assert.equal(result.downloadVerified, true);
  assert.equal(result.storage, 'internal');
  assert.equal(result.bytes, s.bytes.length);
  assert.equal(result.sha256, createHash('sha256').update(s.bytes).digest('hex'));
  assert.equal(result.remotePath, '/userdata/model/history/checked-unique.3mf');
  assert.deepEqual([...new Set((await s.events()).map(event => event.command))], [7, 1, 5, 4]);
});

test('internal listing exposes actual printer paths rather than an empty FTPS cache', async t => {
  const s = await setup(t, { existing: true });
  const result = await listInternalPrinterFiles(s.connection);
  assert.deepEqual(result.files, ['/userdata/model/history/already.3mf']);
  assert.equal(result.entries[0].name, 'already.3mf');
});

test('internal listing waits for every fragment before returning the complete result', async t => {
  const s = await setup(t, { existing: true, multipartList: true });
  const result = await listInternalPrinterFiles(s.connection);
  assert.deepEqual(result.entries.map(file => file.name), ['first.3mf', 'already.3mf']);
});

for (const options of [{ badChecksum: true }, { badOffset: true }]) test(`internal readback rejects corrupt replies ${JSON.stringify(options)}`, async t => {
  const s = await setup(t, options);
  await assert.rejects(uploadInternalPrinterFile(s.connection), /checksum|offsets/);
});

test('internal upload refuses an existing name before sending file bytes', async t => {
  const s = await setup(t, { existing: true });
  await assert.rejects(uploadInternalPrinterFile({ ...s.connection, remoteName: 'ALREADY.3mf' }), /overwrite/);
  assert.equal((await s.events()).some(event => event.command === 5), false);
});

test('printer file-operation errors are terminal and never replayed', async t => {
  const s = await setup(t, { reject: true });
  await assert.rejects(uploadInternalPrinterFile(s.connection), /rejected.*-26/);
  assert.equal((await s.events()).length, 1);
});

test('already canceled transfers never launch a helper', async t => {
  const s = await setup(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(uploadInternalPrinterFile(s.connection, undefined, { signal: controller.signal }), /abort/i);
  assert.deepEqual(await s.events(), []);
});

test('connection failure reports no upload and never sends file requests', async t => {
  const s = await setup(t, { connectionFailure: true });
  await assert.rejects(uploadInternalPrinterFile(s.connection), error => {
    assert.equal(error.uploadStarted, false);
    assert.equal(error.phase, 'connection');
    assert.match(error.message, /No upload was started/);
    assert.match(error.message, /open failed: -1001/);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.deepEqual(await s.events(), []);
});

test('disconnect after upload request reports uncertain storage and never replays', async t => {
  const s = await setup(t, { uploadDisconnect: true });
  await assert.rejects(uploadInternalPrinterFile(s.connection), error => {
    assert.equal(error.uploadStarted, true);
    assert.equal(error.phase, 'upload');
    assert.match(error.message, /unverified file may remain/);
    return true;
  });
  assert.equal((await s.events()).filter(e => e.command === 5).length, 1);
});
