import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveNativeInstall, type BambuNativeExecution, type BambuNativeUpdateCallback } from "./bambu-native.js";

type Connection = { host: string; token: string };
export type InternalPrinterFile = { name: string; path: string; size: number; time?: number | string };
type Reply = { cmdtype: number; sequence: number; result: number; reply?: Record<string, any> };
type Frame = { message: Reply; blob: Buffer };
const MAX_FRAME = 4 * 1024 * 1024;
const MAX_FILE = 256 * 1024 * 1024;
const children = new Set<ChildProcessWithoutNullStreams>();
process.once("exit", () => { for (const child of children) child.kill("SIGKILL"); });

export class BambuFileServiceError extends Error {
  readonly retryable = false;
  readonly route = "local-file-service";
  readonly nativeStage: string | null;
  readonly nativeCode: number | null;
  readonly recovery: string;
  constructor(message: string, readonly phase: string, readonly uploadStarted: boolean) {
    super(`File-service ${phase} failed. ${uploadStarted ? "An incomplete or unverified file may remain on the printer; inspect storage before any new upload." : "No upload was started."} No automatic retry was attempted. ${message}`);
    this.name = "BambuFileServiceError";
    const native = /file-service (create|open|handshake|read|send) failed: (-?\d+)/.exec(message);
    this.nativeStage = native?.[1] ?? null;
    this.nativeCode = native ? Number(native[2]) : null;
    this.recovery = uploadStarted
      ? "Inspect printer storage and verify any existing file before another upload. Do not replay an unverified transfer or start a print to test delivery."
      : phase === "connection"
      ? "Check the local file service on port 6000 and the configured host/access code. Working MQTT or cloud access does not prove storage access. If the file connection keeps closing while other services work, restart the printer only after its job has finished and it has cooled, then recheck list_printer_files. Do not re-slice or change LAN Only/Developer Mode."
      : "Resolve the reported file-operation error, then recheck printer storage before another upload. Do not re-slice or use a print command as a transfer workaround.";
  }

  details() {
    return { route: this.route, phase: this.phase, native_stage: this.nativeStage, native_code: this.nativeCode,
      upload_started: this.uploadStarted, print_requested: false, retryable: false, recovery: this.recovery };
  }
}

/** Private IPC for Studio's file-only tunnel. No print/control messages exist here. */
class FileService {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly frames: Frame[] = [];
  private readonly waiters = new Set<() => void>();
  private failure?: Error;
  private ready = false;
  private phase = "connection";
  private uploadStarted = false;
  private sequence = 0;
  private stdout = "";
  private stderr = "";
  private readonly deadline: NodeJS.Timeout;
  private readonly connectionDeadline: NodeJS.Timeout;
  private readonly abort = () => this.fail(new Error("File transfer canceled; an incomplete file may remain. Check the printer before retrying."));
  private readonly closed: Promise<void>;

  constructor(private readonly connection: Connection, private readonly execution: BambuNativeExecution) {
    execution.signal?.throwIfAborted();
    execution.assertActive?.();
    const install = resolveNativeInstall();
    this.child = spawn(install.helper, ["--file-service"], {
      env: { ...process.env, ...install.env, BAMBU_NATIVE_HOST: connection.host, BAMBU_NATIVE_ACCESS_CODE: connection.token },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(this.child);
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.stdout += chunk;
      try {
        let newline: number;
        while ((newline = this.stdout.indexOf("\n")) >= 0) {
          const line = this.stdout.slice(0, newline).trimEnd();
          this.stdout = this.stdout.slice(newline + 1);
          this.line(line);
        }
        if (this.stdout.length > MAX_FRAME * 2 + 100) throw new Error("File-service frame exceeds size limit.");
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + this.redact(String(chunk))).slice(-2000); });
    this.child.stdin.on("error", error => this.fail(new Error(`File-service input failed: ${this.redact(error.message)}`)));
    this.child.on("error", error => this.fail(new Error(`Could not launch file-service helper: ${this.redact(error.message)}`)));
    this.closed = new Promise(resolve => this.child.once("close", (code, signal) => {
      children.delete(this.child);
      this.fail(new Error(`File-service helper closed (${signal ?? code}). ${this.stderr}`));
      resolve();
    }));
    this.deadline = setTimeout(() => this.fail(new Error("File transfer timed out; a file may remain on the printer. Check its listing before retrying; no automatic replay was attempted.")), 180_000);
    this.connectionDeadline = setTimeout(() => this.fail(new Error("The printer's local file connection did not become ready within 15 seconds. A working MQTT or cloud connection does not establish local storage access.")), 15_000);
    execution.signal?.addEventListener("abort", this.abort, { once: true });
  }

  private redact(value: string) { return value.split(this.connection.token).join("[redacted]"); }
  private changed() { for (const wake of this.waiters) wake(); this.waiters.clear(); }
  private fail(error: Error) {
    this.failure ??= this.describeFailure(error);
    this.child.kill("SIGKILL");
    this.changed();
  }
  describeFailure(error: unknown): BambuFileServiceError {
    return error instanceof BambuFileServiceError ? error : new BambuFileServiceError(error instanceof Error ? error.message : String(error), this.phase, this.uploadStarted);
  }
  private assertActive() {
    if (this.failure) throw this.failure;
    this.execution.signal?.throwIfAborted();
    this.execution.assertActive?.();
  }
  private line(line: string) {
    if (line === "native_file_ready=1") { this.ready = true; clearTimeout(this.connectionDeadline); }
    else if (line.startsWith("native_file_sample=")) {
      const hex = line.slice("native_file_sample=".length);
      if (hex.length > MAX_FRAME * 2 || hex.length % 2 || !/^[0-9a-f]+$/.test(hex)) throw new Error("Invalid file-service frame encoding.");
      const data = Buffer.from(hex, "hex");
      const divider = data.indexOf("\n\n");
      const message: Reply = JSON.parse(data.subarray(0, divider < 0 ? data.length : divider).toString("utf8"));
      if (message.result !== undefined) {
        if (!Number.isSafeInteger(message.sequence) || !Number.isSafeInteger(message.cmdtype) || !Number.isSafeInteger(message.result)) throw new Error("Invalid file-service response.");
        if (this.frames.length >= 4096) throw new Error("Too many pending file-service responses.");
        this.frames.push({ message, blob: divider < 0 ? Buffer.alloc(0) : data.subarray(divider + 2) });
      }
    }
    this.changed();
  }
  private wait() { return new Promise<void>(resolve => this.waiters.add(resolve)); }
  async open() { while (!this.ready) { this.assertActive(); await this.wait(); } this.assertActive(); }
  nextSequence() { return ++this.sequence; }
  async send(command: number, sequence: number, request: Record<string, unknown>, blob?: Buffer) {
    this.assertActive();
    const header = Buffer.from(JSON.stringify({ cmdtype: command, sequence, req: request }));
    const frame = blob ? Buffer.concat([header, Buffer.from("\n\n"), blob]) : header;
    if (frame.length > MAX_FRAME) throw new Error("File-service request exceeds size limit.");
    this.phase = command === 5 ? "upload" : command === 4 ? "readback" : "storage request";
    if (command === 5) this.uploadStarted = true;
    await new Promise<void>((resolve, reject) => this.child.stdin.write(`native_file_send=${frame.toString("hex")}\n`, error => error ? reject(error) : resolve()));
    this.assertActive();
  }
  async read(command: number, sequence: number): Promise<Frame> {
    for (;;) {
      this.assertActive();
      const index = this.frames.findIndex(frame => frame.message.sequence === sequence);
      if (index >= 0) {
        const [frame] = this.frames.splice(index, 1);
        if (frame.message.cmdtype !== command) throw new Error("File-service response command mismatch.");
        if (![0, 1].includes(frame.message.result)) throw new Error(`Printer rejected file operation ${command} (${frame.message.result}).`);
        return frame;
      }
      await this.wait();
    }
  }
  async request(command: number, request: Record<string, unknown>) {
    const sequence = this.nextSequence();
    await this.send(command, sequence, request);
    const frame = await this.read(command, sequence);
    if (frame.message.result !== 0 || frame.blob.length) throw new Error(`Unexpected response to file operation ${command}.`);
    return frame.message.reply ?? {};
  }
  async list(): Promise<InternalPrinterFile[]> {
    const sequence = this.nextSequence();
    await this.send(1, sequence, { type: "model", storage: "emmc", api_version: 2 });
    const files: InternalPrinterFile[] = [];
    for (;;) {
      const { message, blob } = await this.read(1, sequence);
      const reply = message.reply ?? {};
      if (blob.length || !Array.isArray(reply.file_lists)) throw new Error("Printer returned an invalid internal file listing.");
      for (const file of reply.file_lists) {
        if (typeof file?.name !== "string" || typeof file.path !== "string" || !Number.isSafeInteger(file.size) || file.size < 0)
          throw new Error("Printer returned an invalid internal file entry.");
        files.push({ name: file.name, path: file.path, size: file.size, ...(file.time === undefined ? {} : { time: file.time }) });
      }
      if (message.result === 0) return files;
    }
  }
  async upload(filePath: string, remoteName: string, onUpdate?: BambuNativeUpdateCallback) {
    const name = path.posix.basename(remoteName);
    if (!name || name === "." || name === ".." || /[\\\x00-\x1f]/.test(name) || !/\.(3mf|gcode)$/i.test(name))
      throw new Error("Internal uploads require a printable .3mf or .gcode filename.");
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE) throw new Error("Internal upload must be a nonempty file no larger than 256 MiB.");
    const data = await fs.readFile(filePath);
    if (data.length !== stat.size) throw new Error("Upload snapshot changed while reading.");
    const md5 = createHash("md5").update(data).digest("hex");
    const sha256 = createHash("sha256").update(data).digest("hex");
    const abilities = await this.request(7, { peer: "studio", api_version: 1 });
    if (!Array.isArray(abilities.upload_storage) || !abilities.upload_storage.includes("emmc") || !abilities.allow_internal_model_download)
      throw new Error("Printer does not advertise internal upload and readback verification.");
    if ((await this.list()).some(file => file.name.toLowerCase() === name.toLowerCase())) throw new Error("Remote file already exists; refusing to overwrite it.");
    const sequence = this.nextSequence();
    await this.send(5, sequence, { type: "model", storage: "emmc", path: name, total: data.length });
    const initial = (await this.read(5, sequence)).message;
    const chunkSize = initial.reply?.chunk_size * 1024;
    if (initial.result !== 1 || initial.reply?.offset !== 0 || !Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > 1024 * 1024)
      throw new Error("Printer did not accept a new upload with a valid chunk size.");
    onUpdate?.("internal_upload stage=sending");
    let fragment = 0;
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const blob = data.subarray(offset, offset + chunkSize);
      await this.send(5, sequence, { frag_id: fragment++, offset, size: blob.length, ...(offset + blob.length === data.length ? { file_md5: md5 } : {}) }, blob);
    }
    while ((await this.read(5, sequence)).message.result === 1) { /* Wait for the printer's terminal receipt. */ }
    const matches = (await this.list()).filter(file => file.name === name && file.size === data.length);
    if (matches.length !== 1) throw new Error("Uploaded file is absent or ambiguous in the printer's internal listing.");
    const remote = matches[0];
    onUpdate?.("internal_upload stage=readback");
    const downloadSequence = this.nextSequence();
    await this.send(4, downloadSequence, { path: remote.path });
    const downloaded = createHash("sha256");
    let received = 0;
    for (;;) {
      const { message, blob } = await this.read(4, downloadSequence);
      const reply = message.reply ?? {};
      if (reply.offset !== received || reply.total !== data.length || (reply.size ?? 0) !== blob.length || received + blob.length > data.length)
        throw new Error("Internal file readback has inconsistent offsets or sizes.");
      downloaded.update(blob);
      received += blob.length;
      if (message.result === 0) {
        if (received !== data.length || downloaded.digest("hex") !== sha256 || String(reply.file_md5 ?? "").toLowerCase() !== md5)
          throw new Error("Internal file readback checksum differs from the inspected snapshot.");
        break;
      }
    }
    return { remotePath: remote.path, remoteName: name, storage: "internal", bytes: data.length, sha256, md5, downloadVerified: true };
  }
  async close() {
    clearTimeout(this.deadline);
    clearTimeout(this.connectionDeadline);
    this.execution.signal?.removeEventListener("abort", this.abort);
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 1000);
    await this.closed;
    clearTimeout(timer);
  }
}

async function withFileService<T>(connection: Connection, execution: BambuNativeExecution, operation: (service: FileService) => Promise<T>): Promise<T> {
  const service = new FileService(connection, execution);
  try { await service.open(); return await operation(service); }
  catch (error) { throw service.describeFailure(error); }
  finally { await service.close(); }
}

export function listInternalPrinterFiles(connection: Connection, execution: BambuNativeExecution = {}) {
  return withFileService(connection, execution, async service => {
    const entries = await service.list();
    return { files: entries.map(file => file.path), directories: { internal: entries.map(file => file.name) }, entries, storage: "internal" };
  });
}

export function uploadInternalPrinterFile(connection: Connection & { filePath: string; remoteName: string }, onUpdate?: BambuNativeUpdateCallback, execution: BambuNativeExecution = {}) {
  return withFileService(connection, execution, service => service.upload(connection.filePath, connection.remoteName, onUpdate));
}
