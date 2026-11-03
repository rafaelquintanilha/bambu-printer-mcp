import { createDecipheriv } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
/** Studio's documented cache encoding, not a secret supplied by the user. */
const CACHE_KEY = Buffer.from("i4crL3LESLnWapLS");
export function decodeStudioSession(bytes) {
    try {
        const decipher = createDecipheriv("aes-128-ecb", CACHE_KEY, null);
        decipher.setAutoPadding(false);
        const plain = Buffer.concat([decipher.update(bytes), decipher.final()]);
        // Studio versions use zero or block padding after the JSON document.
        const decoded = JSON.parse(plain.toString("utf8").replace(/[\x00-\x10]+$/, ""));
        const user = decoded?.user;
        if (!user || !/^[A-Za-z0-9_+\/=.-]{20,4096}$/.test(user.token) || !user.user_id)
            throw new Error();
        return decoded;
    }
    catch {
        throw new Error("Cannot read the configured Studio cloud session. Sign in to that Studio profile again; no job was submitted.");
    }
}
/** Read the explicitly selected Studio profile without opening or modifying Studio. */
export async function readStudioCloudSession(directory = process.env.BAMBU_CLOUD_STUDIO_DIR) {
    if (!directory)
        throw new Error("Cloud profile is not configured. Set BAMBU_CLOUD_STUDIO_DIR to the signed-in Studio data directory; no job was submitted.");
    const [encoded, config] = await Promise.all([
        fs.readFile(path.join(directory, "BambuNetworkEngine.conf")),
        fs.readFile(path.join(directory, "BambuStudio.conf"), "utf8"),
    ]);
    const session = decodeStudioSession(encoded);
    const app = JSON.parse(config).app;
    if (!app?.slicer_uuid || !/^\d{2}\.\d{2}\.\d{2}\.\d{2}$/.test(app.version))
        throw new Error("Configured Studio profile has no valid client identity/version.");
    const country = session.country_code || app.region;
    if (!country || typeof country !== "string")
        throw new Error("Configured Studio profile has no region.");
    return { directory, encoded, session, version: app.version, deviceId: String(app.slicer_uuid), country };
}
export async function verifyCloudPrinter(serial, signal, profile) {
    const p = profile ?? await readStudioCloudSession();
    const host = /^(China|CN)$/i.test(p.country) ? "https://api.bambulab.cn" : "https://api.bambulab.com";
    const timeout = AbortSignal.timeout(15000);
    const response = await fetch(`${host}/v1/iot-service/api/user/bind`, {
        method: "GET", redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
            Authorization: `Bearer ${p.session.user.token}`, Accept: "application/json",
            "User-Agent": `bambu_network_agent/${p.version}`, "X-BBL-Client-Type": "slicer",
            "X-BBL-Client-Name": "BambuStudio", "X-BBL-Client-Version": p.version,
            "X-BBL-OS-Type": "macos", "X-BBL-Device-ID": p.deviceId,
        },
    });
    if (!response.ok)
        throw new Error(`Bambu cloud authentication/device lookup failed (HTTP ${response.status}); no job was submitted. Reauthenticate the configured Studio profile if the session has expired.`);
    let body;
    try {
        body = await response.json();
    }
    catch {
        throw new Error("Bambu cloud returned a non-JSON device response; no job was submitted.");
    }
    if (!Array.isArray(body.devices) || body.error || (body.code !== undefined && body.code !== null && body.code !== 0))
        throw new Error("Bambu cloud rejected the device lookup; no job was submitted.");
    const device = body.devices.find((entry) => entry.dev_id === serial);
    if (!device)
        throw new Error("The configured printer is not bound to this Studio cloud account; no job was submitted.");
    return { authenticated: true, printer_matched: true, online: device.online === true, model: device.dev_product_name ?? device.dev_model_name ?? null,
        checked_at: new Date().toISOString(), submission: "not_checked", physical_print: "not_checked" };
}
/** A disposable copy prevents the native agent from updating Studio's own login. */
export async function withStudioCloudSession(serial, signal, operation) {
    if (process.platform !== "darwin")
        throw new Error("Studio cloud-session reuse currently supports macOS only.");
    const profile = await readStudioCloudSession();
    const verified = await verifyCloudPrinter(serial, signal, profile);
    if (!verified.online)
        throw new Error("Bambu cloud reports the configured printer offline; no job was submitted.");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-cloud-"));
    try {
        await fs.chmod(directory, 0o700);
        await fs.writeFile(path.join(directory, "BambuNetworkEngine.conf"), profile.encoded, { mode: 0o600 });
        await fs.writeFile(path.join(directory, "cloud-token"), profile.session.user.token, { mode: 0o600 });
        signal?.throwIfAborted();
        return await operation({ BAMBU_NATIVE_CONFIG_DIR: directory, BAMBU_NATIVE_COUNTRY: profile.country,
            BAMBU_NATIVE_STUDIO_VERSION: profile.version, BAMBU_NATIVE_STUDIO_DEVICE_ID: profile.deviceId,
            BAMBU_NATIVE_PLUGIN: path.join(profile.directory, "plugins", "libbambu_networking.dylib") });
    }
    finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}
/** Derive cloud mappings from the checked snapshot and observed selected spools. */
export async function cloudPrintMetadata(snapshot, inspection, state) {
    const zip = await JSZip.loadAsync(await fs.readFile(snapshot));
    const settings = JSON.parse(await zip.file("Metadata/project_settings.config").async("string"));
    const gcode = await zip.file(inspection.plateInternalPath).async("string");
    const map = /^;\s*physical_extruder_map\s*=\s*([0-9, ]+)\s*$/m.exec(gcode)?.[1].split(",").map(Number);
    if (!map || map.length !== inspection.nozzleDiameters.length || new Set(map).size !== map.length || map.some(id => !state.nozzles.some(nozzle => nozzle.index === id)))
        throw new Error("Cloud printing requires an inspected physical nozzle map; no job was submitted.");
    const nozzles = map.map(id => {
        const nozzle = state.nozzles.find(n => n.index === id);
        const flowSize = { standard: "standard_flow", highflow: "high_flow", tpuhighflow: "tpu_high_flow", e3dhighflow: "e3d_high_flow" }[nozzle.flow ?? ""];
        if (!flowSize)
            throw new Error("Cloud nozzle flow is not known; no job was submitted.");
        return { id, diameter: nozzle.diameter, flowSize, type: null };
    });
    const details = state.filaments.map(filament => {
        const position = filament.filamentPosition;
        const id = inspection.filamentNozzleIndices?.[position];
        const source = settings.filament_colour?.[position];
        const target = filament.color;
        const profile = settings.filament_ids?.[position] ?? filament.profile;
        if (id === undefined || !map.includes(id) || filament.slot === undefined || !/^#?[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(source ?? "") || !/^[0-9A-Fa-f]{8}$/.test(target ?? "") || !profile)
            throw new Error("Cloud filament mapping is incomplete; no job was submitted.");
        return { ams: filament.slot >= 254 ? -1 : filament.slot, filamentId: profile, filamentType: inspection.materials[position], nozzleId: id,
            sourceColor: "#" + source.replace(/^#/, "").padEnd(8, "F"), targetColor: target };
    });
    return { nozzleMapping: JSON.stringify(map), nozzlesInfo: JSON.stringify(nozzles), amsMappingInfo: JSON.stringify(details) };
}
