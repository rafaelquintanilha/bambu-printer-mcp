import { spawn, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/**
 * Keeps one MCP stdio session with the client and runs the X2D server as a
 * child. Before forwarding a new request it checks the built files; when they
 * changed and no request is in flight, it starts a child on the new build,
 * replays the client's initialize handshake, and retires the old child. A
 * crashed child is replaced on the next request. Clients never reconnect.
 */
export type SupervisorOptions = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  distDirectory: string;
  /** A build must be this old before it is loaded, so a running tsc is not caught midway. */
  settleMs?: number;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  log?: (message: string) => void;
};

type Id = string | number;
type Message = { jsonrpc?: string; id?: Id | null; method?: string; params?: any; result?: any; error?: any };
type Child = { process: ChildProcessByStdio<Writable, Readable, null>; signature: string; exited: boolean; internal: Map<Id, (message: Message) => void> };

/** Cheap fingerprint of the loaded JavaScript plus the newest write time. */
export function distSignature(directory: string): { signature: string; newestMs: number } {
  const entries: string[] = [];
  let newestMs = 0;
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        const stat = fs.statSync(file);
        newestMs = Math.max(newestMs, stat.mtimeMs);
        entries.push(`${path.relative(directory, file)}:${stat.size}:${stat.mtimeMs}`);
      }
    }
  };
  visit(directory);
  return { signature: entries.join("|"), newestMs };
}

export function runX2dSupervisor(options: SupervisorOptions): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.log ?? ((message: string) => process.stderr.write(`[bambu-x2d supervisor] ${message}\n`));
  const settleMs = options.settleMs ?? 1500;
  let initialize: Message | undefined;
  let initialized = false;
  let child: Child | undefined;
  let internalSequence = 0;
  let closing = false;
  // Requests awaiting a reply, and which child owns them.
  const clientRequests = new Map<Id, Child>();
  const childRequests = new Map<Id, Child>();
  const send = (line: string) => { output.write(`${line}\n`); };
  const key = (id: Id) => `${typeof id}:${id}`;
  const clientKeys = new Map<string, Id>();

  const start = (): Child => {
    const { signature } = distSignature(options.distDirectory);
    const proc = spawn(options.command, options.args, { env: options.env, stdio: ["pipe", "pipe", "inherit"] });
    const started: Child = { process: proc, signature, exited: false, internal: new Map() };
    createInterface({ input: proc.stdout, crlfDelay: Infinity }).on("line", line => onChildLine(started, line));
    proc.stdin.on("error", () => {});
    proc.on("exit", (code, signal) => {
      started.exited = true;
      for (const [k, owner] of [...clientRequests.entries()]) {
        if (owner !== started) continue;
        clientRequests.delete(k);
        const id = clientKeys.get(String(k));
        clientKeys.delete(String(k));
        // A dropped upload or print reply is uncertain, not failed.
        send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603,
          message: "The connector process exited before replying. If this was an upload or print, check the printer and its storage before any new attempt; nothing is resent automatically." } }));
      }
      for (const [k, owner] of [...childRequests.entries()]) if (owner === started) childRequests.delete(k);
      for (const resolve of started.internal.values()) resolve({ error: { message: `exited (${signal ?? code})` } });
      started.internal.clear();
      if (child === started) {
        child = undefined;
        if (!closing) log(`server exited (${signal ?? code}); a new one starts with the next request`);
      }
      if (closing && !child) finish();
    });
    return started;
  };

  const onChildLine = (owner: Child, line: string) => {
    let message: Message | undefined;
    try { message = JSON.parse(line); } catch { /* not JSON-RPC; pass it through */ }
    if (message && message.id !== undefined && message.id !== null && message.method === undefined) {
      const internal = owner.internal.get(message.id);
      if (internal) { owner.internal.delete(message.id); internal(message); return; }
      clientRequests.delete(key(message.id));
      clientKeys.delete(key(message.id));
    } else if (message && message.id !== undefined && message.id !== null && message.method !== undefined) {
      childRequests.set(key(message.id), owner);
    }
    // Only the current child talks to the client; a retiring child has no open requests.
    if (owner === child || (message?.id !== undefined && message.method === undefined)) send(line);
  };

  const write = (target: Child, message: Message | string) => {
    target.process.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  };

  /** Start a child on the current build and replay the handshake; undefined if it fails. */
  const replacement = async (): Promise<Child | undefined> => {
    const next = start();
    if (!initialize) return next;
    const id = `bambu-x2d-supervisor-${++internalSequence}`;
    const reply = await new Promise<Message>(resolve => {
      const timer = setTimeout(() => resolve({ error: { message: "initialize timed out" } }), 20_000);
      next.internal.set(id, message => { clearTimeout(timer); resolve(message); });
      write(next, { ...initialize, id });
    });
    if (reply.error || next.exited) {
      log(`new build did not start (${reply.error?.message ?? "exited"}); keeping the running server`);
      next.process.stdin.end();
      next.process.kill("SIGTERM");
      return undefined;
    }
    if (initialized) write(next, { jsonrpc: "2.0", method: "notifications/initialized" });
    if (reply.result?.capabilities?.tools?.listChanged) send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }));
    return next;
  };

  const retire = (old: Child) => {
    old.process.stdin.end();
    const term = setTimeout(() => { if (!old.exited) old.process.kill("SIGTERM"); }, 5_000);
    const kill = setTimeout(() => { if (!old.exited) old.process.kill("SIGKILL"); }, 10_000);
    old.process.once("exit", () => { clearTimeout(term); clearTimeout(kill); });
  };

  const current = async (): Promise<Child | undefined> => {
    if (!child) {
      child = await replacement();
      return child;
    }
    if (!initialize || !initialized || clientRequests.size || childRequests.size) return child;
    const { signature, newestMs } = distSignature(options.distDirectory);
    // File times can be a fraction of a millisecond ahead of Date.now().
    if (signature === child.signature || (settleMs > 0 && Date.now() - newestMs < settleMs)) return child;
    const next = await replacement();
    if (!next) {
      // Do not retry this exact build on every request.
      child.signature = signature;
      return child;
    }
    log("loaded the rebuilt server");
    const old = child;
    child = next;
    retire(old);
    return child;
  };

  let queue = Promise.resolve();
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>(resolve => { resolveDone = resolve; });
  let exitCode = 0;
  const finish = () => resolveDone(exitCode);

  if (!options.input) {
    // Let the server run its own shutdown, as it did when it was the client's process.
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      process.once(signal, () => {
        closing = true;
        exitCode = code;
        if (child && !child.exited) child.process.kill(signal);
        else finish();
      });
    }
  }

  child = start();
  createInterface({ input, crlfDelay: Infinity }).on("line", line => {
    queue = queue.then(async () => {
      let message: Message | undefined;
      try { message = JSON.parse(line); } catch { /* forward unparsed */ }
      if (message?.method === "initialize") initialize = structuredClone(message);
      if (message?.method === "notifications/initialized") initialized = true;
      const isRequest = message && message.id !== undefined && message.id !== null && message.method !== undefined;
      const isResponse = message && message.id !== undefined && message.id !== null && message.method === undefined;
      if (isResponse) {
        // A reply to the child's own request goes back to that child.
        const owner = childRequests.get(key(message!.id!));
        childRequests.delete(key(message!.id!));
        if (owner && !owner.exited) write(owner, line);
        return;
      }
      const target = isRequest && message!.method !== "initialize" ? await current() : child ?? await current();
      if (!target) {
        if (isRequest) send(JSON.stringify({ jsonrpc: "2.0", id: message!.id, error: { code: -32603, message: "The connector could not start; no command was sent." } }));
        return;
      }
      if (isRequest) { clientRequests.set(key(message!.id!), target); clientKeys.set(key(message!.id!), message!.id!); }
      write(target, line);
    }).catch(error => log(`forwarding failed: ${error instanceof Error ? error.message : String(error)}`));
  }).on("close", () => {
    void queue.then(() => {
      closing = true;
      if (!child) { finish(); return; }
      child.process.stdin.end();
    });
  });
  return done;
}
