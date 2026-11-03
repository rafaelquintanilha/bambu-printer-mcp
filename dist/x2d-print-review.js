import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import JSZip from "jszip";
import { parseStringPromise } from "xml2js";
import { analyze3MFPlateObjects } from "./3mf_parser.js";
const REVIEW_TTL_MS = 10 * 60000;
const CAMERA_TTL_MS = 2 * 60000;
/** Call only after inspecting the snapshot's archive and G-code. */
export async function printReviewDetails(snapshot, plateIndex) {
    const { objects } = await analyze3MFPlateObjects(snapshot, plateIndex);
    if (!objects.length)
        throw new Error("The selected plate has no reviewable object list. Export the sliced 3MF again before printing.");
    const zip = await JSZip.loadAsync(await fs.readFile(snapshot));
    const info = zip.file("Metadata/slice_info.config");
    const parsed = info ? await parseStringPromise(await info.async("string"), { explicitArray: false, mergeAttrs: true }) : {};
    const list = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
    const plate = list(parsed?.config?.plate).find(plate => list(plate.metadata).some(item => item.key === "index" && Number(item.value) === plateIndex + 1));
    const metadata = Object.fromEntries(list(plate?.metadata).map(item => [item.key, item.value]));
    const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
    return { object_count: objects.length, objects: objects.map(object => ({ id: object.id, name: object.name })),
        estimated_seconds: positive(metadata.prediction), estimated_grams: positive(metadata.weight) };
}
/** Only fields relevant to the reviewed job; cooling temperatures are allowed to change. */
export function printReviewState(status, checked, requirements) {
    const raw = status.raw;
    const filaments = (requirements.usedFilamentPositions ?? []).map(position => {
        const slot = requirements.amsMapping?.[position];
        let tray;
        if (slot === 254 || slot === 255)
            tray = raw.vir_slot?.find((entry) => Number(entry.id) === slot);
        else if (slot !== undefined && slot >= 0) {
            const unit = slot >= 128 ? slot : Math.floor(slot / 4);
            const trayId = slot >= 128 ? 0 : slot % 4;
            tray = raw.ams?.ams?.find((entry) => Number(entry.id) === unit)?.tray?.find((entry) => Number(entry.id) === trayId);
        }
        return { filamentPosition: position, slot, material: tray?.tray_type ?? null,
            color: tray?.tray_color ?? null, profile: tray?.tray_info_idx ?? null,
            tag: tray?.tag_uid ?? null, spool: tray?.tray_uuid ?? null };
    });
    return {
        model: checked.model, serial: status.serial,
        previousJob: [raw.gcode_state, raw.gcode_file, raw.subtask_name, raw.task_id, raw.subtask_id, raw.job_id],
        nozzles: checked.reportedNozzles.map(nozzle => ({ index: nozzle.index, diameter: nozzle.diameter, type: nozzle.type, flow: nozzle.flow })),
        plate: [raw.device?.plate?.base, raw.device?.plate?.mat, raw.device?.plate?.cur_id],
        filaments,
    };
}
/** One pending job per local X2D session. Chat approval is a trusted-client attestation. */
export class X2dPrintReviews {
    constructor(now = Date.now) {
        this.now = now;
    }
    invalidate() { this.pending = undefined; }
    recordCamera(host, serial) {
        this.camera = { id: randomUUID(), capturedAt: this.now(), host, serial };
        return { ...this.camera };
    }
    prepare(input) {
        const createdAt = this.now();
        this.pending = structuredClone({ ...input, id: randomUUID(), createdAt, expiresAt: createdAt + REVIEW_TTL_MS });
        return structuredClone(this.pending);
    }
    consume(args) {
        const review = this.pending;
        if (!review || args.approval_id !== review.id)
            throw new Error("Unknown or already used print review. Prepare the print again; no command was sent.");
        // Consume before any asynchronous work, even if validation or dispatch later fails.
        this.pending = undefined;
        if (args.user_approved !== true || typeof args.user_approval !== "string" || !args.user_approval.trim()) {
            throw new Error("Explicit user approval of this reviewed job is required. No command was sent.");
        }
        if (args.plate_clear !== true)
            throw new Error("Inspect the camera image and confirm the plate is clear. No command was sent.");
        const camera = this.camera;
        if (!camera || camera.id !== args.camera_capture_id || camera.capturedAt < review.createdAt ||
            camera.host !== review.host || camera.serial !== review.serial) {
            throw new Error("Review a camera capture from this printer taken after preparing this job. No command was sent.");
        }
        const approved = { review, camera: { ...camera }, userApproval: args.user_approval };
        this.assertFresh(approved);
        return approved;
    }
    assertFresh(approved) {
        const now = this.now();
        if (now >= approved.review.expiresAt)
            throw new Error("Print review expired. Prepare and approve it again; no command was sent.");
        if (now - approved.camera.capturedAt >= CAMERA_TTL_MS) {
            throw new Error("Camera clearance is older than two minutes. Prepare a new review and inspect its fresh image; no command was sent.");
        }
    }
    assertMatches(approved, host, serial, inspection, state) {
        this.assertFresh(approved);
        const review = approved.review;
        if (host !== review.host || serial !== review.serial || inspection.sha256 !== review.inspection.sha256 ||
            inspection.plateInternalPath !== review.inspection.plateInternalPath) {
            throw new Error("Print file, plate or printer changed after review. Prepare and approve a new review; no command was sent.");
        }
        if (JSON.stringify(state) !== JSON.stringify(review.state)) {
            throw new Error("Printer job, nozzle, plate or selected filament/color changed after review. Prepare and approve a new review; no command was sent.");
        }
    }
}
