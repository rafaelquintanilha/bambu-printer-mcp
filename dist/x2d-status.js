import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const MAX_REPORT_AGE_MS = 30000;
const ACTIVE_STATES = new Set(["RUNNING", "PREPARE", "SLICING", "PAUSE"]);
const TERMINAL_STATES = new Set(["FINISH", "FAILED"]);
const nullableNumber = (value) => (typeof value === "number" || typeof value === "string" && value.trim() !== "") && Number.isFinite(Number(value)) ? Number(value) : null;
const identifier = (value) => {
    if (typeof value !== "string" && typeof value !== "number")
        return null;
    const result = String(value).trim();
    return result && result !== "0" && result !== "-1" ? result : null;
};
/** Display data only. Print/heater safety always uses independent fresh telemetry. */
export function compactX2dStatus(status, now = Date.now()) {
    const raw = status.raw ?? {};
    const receivedAt = nullableNumber(status.observation?.receivedAt);
    const age = receivedAt === null ? null : Math.max(0, now - receivedAt);
    const state = typeof status.status === "string" ? status.status : "UNKNOWN";
    const layer = nullableNumber(status.print?.currentLayer ?? raw.layer_num);
    const stage = state === "RUNNING" ? (layer !== null && layer > 0 ? "printing" : "preparing") :
        { PREPARE: "preparing", SLICING: "preparing", PAUSE: "paused", FINISH: "finished", FAILED: "failed", IDLE: "idle" }[state] ?? "unknown";
    const name = typeof status.print?.filename === "string" && status.print.filename !== "None" ? status.print.filename : null;
    const taskId = identifier(raw.task_id);
    const subtaskId = identifier(raw.subtask_id);
    const jobId = identifier(raw.job_id);
    return {
        schema_version: 1,
        status: state,
        connected: status.connected === true,
        model: status.model ?? "X2D",
        serial: status.serial ?? null,
        observation: {
            source: "mqtt-cache",
            observed_at: receivedAt === null ? null : new Date(receivedAt).toISOString(),
            age_ms: age,
            stale: status.connected !== true || age === null || age > MAX_REPORT_AGE_MS,
            received_after_request: receivedAt !== null && receivedAt >= (status.observation?.requestedAt ?? Infinity),
        },
        print: {
            filename: name,
            task_id: taskId,
            subtask_id: subtaskId,
            job_id: jobId,
            file: typeof raw.gcode_file === "string" ? raw.gcode_file : null,
            identity_quality: taskId || subtaskId || jobId ? "printer_id" : name || raw.gcode_file ? "filename" : "unknown",
            stage,
            stage_code: nullableNumber(raw.stg_cur),
            progress: nullableNumber(status.print?.progress),
            timeRemaining: nullableNumber(status.print?.timeRemaining),
            time_remaining_unit: "minutes",
            currentLayer: layer,
            totalLayers: nullableNumber(status.print?.totalLayers),
        },
        temperatures: status.temperatures ?? null,
        active_ams_slot: nullableNumber(raw.ams?.tray_now),
        errors: {
            print_error: nullableNumber(raw.print_error),
            hms: Array.isArray(raw.hms) ? raw.hms : null,
            fail_reason: typeof raw.fail_reason === "string" || typeof raw.fail_reason === "number" ? raw.fail_reason : null,
            ...(status.error ? { connection_error: String(status.error) } : {}),
        },
    };
}
function jobIdentity(status) {
    const job = status.print;
    if (job.subtask_id)
        return `subtask:${job.task_id ?? ""}:${job.subtask_id}`;
    if (job.task_id)
        return `task:${job.task_id}`;
    if (job.job_id)
        return `job:${job.job_id}`;
    if (job.file || job.filename)
        return `file:${JSON.stringify([job.file, job.filename])}`;
    return null;
}
/** Local SQLite transactions keep simultaneous MCP sessions from losing observations. */
export class X2dJobHistory {
    constructor(directory) {
        this.directory = directory;
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, "jobs.sqlite");
        this.db = new DatabaseSync(file);
        fs.chmodSync(file, 0o600);
        this.db.exec(`
      PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, serial TEXT NOT NULL, observed_at INTEGER NOT NULL, record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_by_printer ON jobs(serial, observed_at DESC);
      CREATE TABLE IF NOT EXISTS printer_observations (
        serial TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, current_job TEXT
      );
    `);
    }
    close() { this.db.close(); }
    observe(status) {
        const observedAt = status.observation.observed_at;
        if (!status.serial || status.observation.stale || !observedAt) {
            return { recorded: false, reason: "No fresh identified printer observation", current_job_id: null };
        }
        const at = Date.parse(observedAt);
        const serial = String(status.serial);
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const previous = this.db.prepare("SELECT observed_at, current_job FROM printer_observations WHERE serial = ?").get(serial);
            if (previous && Number(previous.observed_at) >= at) {
                this.db.exec("COMMIT");
                return { recorded: false, reason: "Observation already recorded or older than stored state", current_job_id: previous.current_job ?? null };
            }
            const row = previous?.current_job ? this.db.prepare("SELECT record FROM jobs WHERE id = ?").get(previous.current_job) : undefined;
            const last = row ? JSON.parse(String(row.record)) : undefined;
            const identity = jobIdentity(status);
            const hasJob = identity !== null && (ACTIVE_STATES.has(status.status) || TERMINAL_STATES.has(status.status));
            // A repeat of the same filename after a terminal state is a new physical run.
            const newRun = last && TERMINAL_STATES.has(last.latest.status) && ACTIVE_STATES.has(status.status);
            const sameJob = last && hasJob && last.identity === identity && !newRun;
            if (last && !sameJob && last.outcome === null) {
                last.outcome = "unknown";
                this.db.prepare("UPDATE jobs SET record = ? WHERE id = ?").run(JSON.stringify(last), last.id);
            }
            let current;
            if (hasJob) {
                const outcome = status.status === "FINISH" ? "finished" : status.status === "FAILED" ?
                    (String(status.errors.fail_reason).toUpperCase() === "0300400C" ? "cancelled" : "failed") : null;
                current = {
                    id: sameJob ? last.id : randomUUID(), identity: identity,
                    first_observed_at: sameJob ? last.first_observed_at : observedAt,
                    last_observed_at: observedAt,
                    terminal_observed_at: outcome ? (sameJob ? last.terminal_observed_at ?? observedAt : observedAt) : null,
                    outcome, latest: status,
                };
                this.db.prepare("INSERT INTO jobs(id, serial, observed_at, record) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at, record=excluded.record")
                    .run(current.id, serial, at, JSON.stringify(current));
            }
            this.db.prepare("INSERT INTO printer_observations(serial, observed_at, current_job) VALUES (?, ?, ?) ON CONFLICT(serial) DO UPDATE SET observed_at=excluded.observed_at, current_job=excluded.current_job")
                .run(serial, at, current?.id ?? null);
            this.db.prepare("DELETE FROM jobs WHERE serial = ? AND id NOT IN (SELECT id FROM jobs WHERE serial = ? ORDER BY observed_at DESC LIMIT 100)").run(serial, serial);
            this.db.exec("COMMIT");
            return { recorded: true, current_job_id: current?.id ?? null };
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    list(serial, limit = 10) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 50)
            throw new Error("History limit must be an integer from 1 to 50.");
        const observation = this.db.prepare("SELECT observed_at, current_job FROM printer_observations WHERE serial = ?").get(serial);
        return {
            source: "saved_observations", live_status: false,
            last_observed_at: observation ? new Date(Number(observation.observed_at)).toISOString() : null,
            last_observed_job_id: observation?.current_job ?? null,
            jobs: this.db.prepare("SELECT record FROM jobs WHERE serial = ? ORDER BY observed_at DESC LIMIT ?").all(serial, limit)
                .map(row => JSON.parse(String(row.record))),
        };
    }
}
/** Hash the loaded distribution at startup so later disk changes require an explicit restart. */
export function connectorBuildId(directory) {
    const hash = createHash("sha256");
    const visit = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const file = path.join(current, entry.name);
            if (entry.isDirectory())
                visit(file);
            else if (entry.isFile() && entry.name.endsWith(".js"))
                hash.update(path.relative(directory, file)).update("\0").update(fs.readFileSync(file));
        }
    };
    visit(directory);
    return hash.digest("hex").slice(0, 16);
}
