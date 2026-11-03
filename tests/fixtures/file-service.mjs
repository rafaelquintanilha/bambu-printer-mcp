import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

/** In-memory printer storage; deliberately implements no print commands. */
export async function runFakeFileService({ eventsFile, existing = false, badChecksum = false, badOffset = false, reject = false, multipartList = false, connectionFailure = false, uploadDisconnect = false } = {}) {
  let name, bytes = Buffer.alloc(0), uploaded = false;
  const reply = (command, sequence, result, data, blob) => {
    const header = Buffer.from(JSON.stringify({ cmdtype: command, sequence, result, reply: data }));
    console.log('native_file_sample=' + (blob ? Buffer.concat([header, Buffer.from('\n\n'), blob]) : header).toString('hex'));
  };
  if (connectionFailure) { console.error('native_error=file-service open failed: -1001'); process.exit(1); }
  console.log('native_file_ready=1');
  for await (const line of createInterface({ input: process.stdin })) {
    const frame = Buffer.from(line.slice('native_file_send='.length), 'hex');
    const divider = frame.indexOf('\n\n');
    const { cmdtype: command, sequence, req } = JSON.parse(frame.subarray(0, divider < 0 ? frame.length : divider));
    const blob = divider < 0 ? Buffer.alloc(0) : frame.subarray(divider + 2);
    if (eventsFile) appendFileSync(eventsFile, JSON.stringify({ mode: 'file-request', command, req }) + '\n');
    if (reject) { reply(command, sequence, -26, {}); continue; }
    if (command === 7) reply(command, sequence, 0, { upload_storage: ['emmc'], allow_internal_model_download: true });
    else if (command === 1) {
      if (multipartList) reply(command, sequence, 1, { file_lists: [{ name: 'first.3mf', path: '/userdata/model/history/first.3mf', size: 10 }] });
      reply(command, sequence, 0, { file_lists: uploaded || existing ? [{ name: name || 'already.3mf', path: '/userdata/model/history/' + (name || 'already.3mf'), size: bytes.length }] : [] });
    }
    else if (command === 5 && req.total !== undefined) {
      if (uploadDisconnect) process.exit(1);
      name = req.path;
      reply(command, sequence, 1, { offset: 0, chunk_size: 1 });
    } else if (command === 5) {
      if (req.offset !== bytes.length || req.size !== blob.length) throw new Error('Invalid upload fragment');
      bytes = Buffer.concat([bytes, blob]);
      if (req.file_md5) {
        if (req.file_md5 !== createHash('md5').update(bytes).digest('hex')) throw new Error('Invalid upload checksum');
        uploaded = true;
        reply(command, sequence, 0, {});
      }
    } else if (command === 4) {
      for (let offset = 0; offset < bytes.length; offset += 512) {
        const part = bytes.subarray(offset, offset + 512);
        const done = offset + part.length === bytes.length;
        reply(command, sequence, done ? 0 : 1, { offset: badOffset ? offset + 1 : offset, total: bytes.length, size: part.length,
          ...(done ? { file_md5: badChecksum ? '0'.repeat(32) : createHash('md5').update(bytes).digest('hex') } : {}) }, part);
      }
    } else throw new Error('Unexpected command: ' + command);
  }
}
