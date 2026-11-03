import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseStringPromise } from "xml2js";
import { readBoundedPrintFile, loadSafe3mfArchive } from "./safety/archive.js";

type Model = { url: string; title: string; design_id?: string; cover_url?: string };
type Collection = { url: string; title: string; observed_at: string; models: Model[] };
type Plate = { number: number; object_count: number | null; objects: string[]; estimated_seconds: number | null; estimated_grams: number | null };
type SavedFile = {
  path: string; sha256: string; bytes: number; modified_at: string;
  kind: "prepared_3mf" | "source_project" | "gcode" | "mesh";
  title: string | null; designer: string | null; design_id: string | null; profile_id: string | null; profile_title: string | null;
  printer_model: string | null; nozzles: string[]; materials: string[]; colors: string[];
  settings: Record<string, unknown>; plates: Plate[]; preview_entry: string | null;
  preview?: { format: "image/png"; base64: string; sizeBytes: number };
};
type PrinterFile = { name: string; path: string; size: number };
const list = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const strings = (value: unknown): string[] => value === undefined ? [] : list(value).map(String);
const positive = (value: unknown): number | null => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
const normalized = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const xmlOptions = { explicitArray: false, mergeAttrs: true };
const METADATA_VERSION = 2;

export function makerworldUrl(raw: string, kind: "models" | "collections"): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.hostname !== "makerworld.com" || url.username || url.password || url.port ||
      !new RegExp(`^/(?:[a-z]{2}/)?${kind}/[1-9][0-9]*(?:-[^/]*)?/?$`).test(url.pathname))
    throw new Error(`Expected an HTTPS MakerWorld ${kind} URL.`);
  const id = url.pathname.match(new RegExp(`/${kind}/([0-9]+)`))![1];
  return `https://makerworld.com/en/${kind}/${id}`;
}

/** File metadata is a discovery aid; exact print inspection remains independent. */
export async function inspectSavedFile(filePath: string, includePreview = false): Promise<SavedFile> {
  const file = fs.realpathSync(filePath);
  const stat = fs.statSync(file);
  const bytes = await readBoundedPrintFile(file);
  const result: SavedFile = {
    path: file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
    modified_at: stat.mtime.toISOString(), kind: "source_project", title: null, designer: null,
    design_id: null, profile_id: null, profile_title: null, printer_model: null,
    nozzles: [], materials: [], colors: [], settings: {}, plates: [], preview_entry: null,
  };
  const extension = path.extname(file).toLowerCase();
  if (extension === ".stl") return { ...result, kind: "mesh" };
  if (extension === ".gcode") {
    const header = bytes.subarray(0, 65536).toString("utf8");
    const setting = (key: string) => header.match(new RegExp(`^;\\s*${key}\\s*=\\s*(.+)$`, "m"))?.[1].trim();
    return { ...result, kind: "gcode", printer_model: setting("printer_model") ?? null,
      nozzles: (setting("nozzle_diameter") ?? "").split(";").filter(Boolean),
      materials: (setting("filament_type") ?? "").split(";").filter(Boolean),
      colors: (setting("filament_colour") ?? "").split(";").filter(Boolean) };
  }
  if (extension !== ".3mf") throw new Error("Saved print details require .3mf, .gcode or .stl.");
  const zip = await loadSafe3mfArchive(bytes);
  const small = async (name: string) => {
    const entry = zip.file(name);
    if (!entry) return null;
    const data = await entry.async("nodebuffer");
    if (data.length > 2 * 1024 * 1024) throw new Error(`Library metadata exceeds 2 MiB: ${name}`);
    return data.toString("utf8");
  };
  const model = zip.file("3D/3dmodel.model");
  if (model) {
    // The 3MF header contains identity metadata before resources/geometry.
    const text = (await model.async("nodebuffer")).subarray(0, 65536).toString("utf8");
    const resource = text.search(/<resources\b/);
    if (resource >= 0) {
      const parsed = await parseStringPromise(text.slice(0, resource) + "</model>", xmlOptions);
      const metadata = Object.fromEntries(list<any>(parsed.model?.metadata).map(item => [item.name, item._ ?? ""]));
      for (const [field, key] of Object.entries({ title: "Title", designer: "Designer", design_id: "DesignModelId", profile_id: "DesignProfileId", profile_title: "ProfileTitle" })) {
        (result as any)[field] = typeof metadata[key] === "string" && metadata[key].trim() ? metadata[key].trim() : null;
      }
    }
  }
  const configText = await small("Metadata/project_settings.config");
  const config = configText ? JSON.parse(configText) : {};
  result.printer_model = typeof config.printer_model === "string" ? config.printer_model : null;
  result.nozzles = strings(config.nozzle_diameter);
  result.materials = strings(config.filament_type);
  result.colors = strings(config.filament_colour);
  for (const key of ["layer_height", "enable_support", "support_type", "support_style", "sparse_infill_density", "wall_loops", "print_sequence", "filament_map", "physical_extruder_map"])
    if (config[key] !== undefined) result.settings[key] = config[key];
  const plates = Object.keys(zip.files).flatMap(name => {
    const match = /^Metadata\/plate_([1-9][0-9]*)\.gcode$/.exec(name);
    return match ? [Number(match[1])] : [];
  }).sort((a, b) => a - b);
  result.kind = plates.length ? "prepared_3mf" : "source_project";
  const infoText = await small("Metadata/slice_info.config");
  const info = infoText ? await parseStringPromise(infoText, xmlOptions) : {};
  for (const number of plates) {
    const plate = list<any>(info.config?.plate).find(item => list<any>(item.metadata).some(meta => meta.key === "index" && Number(meta.value) === number));
    const metadata = Object.fromEntries(list<any>(plate?.metadata).map(item => [item.key, item.value]));
    const objects = list<any>(plate?.object).filter(item => String(item.skipped).toLowerCase() !== "true").map(item => String(item.name ?? ""));
    result.plates.push({ number, object_count: plate?.object === undefined ? null : objects.length, objects,
      estimated_seconds: positive(metadata.prediction), estimated_grams: positive(metadata.weight) });
  }
  result.preview_entry = Object.keys(zip.files).find(name => /^Metadata\/plate_[1-9][0-9]*\.png$/.test(name)) ?? null;
  if (includePreview && result.preview_entry) {
    const data = await zip.file(result.preview_entry)!.async("nodebuffer");
    if (data.length < 24 || data.length > 2 * 1024 * 1024 || data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
        !data.readUInt32BE(16) || !data.readUInt32BE(20) || data.readUInt32BE(16) > 4096 || data.readUInt32BE(20) > 4096)
      throw new Error("Saved plate preview is invalid or exceeds its image limits.");
    result.preview = { format: "image/png", base64: data.toString("base64"), sizeBytes: data.length };
  }
  return result;
}

export class PrintLibrary {
  private readonly db: DatabaseSync;
  constructor(directory: string, readonly roots: string[]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "library.sqlite");
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS library_files(path TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS makerworld_collections(url TEXT PRIMARY KEY, record TEXT NOT NULL);`);
  }
  close() { this.db.close(); }

  saveCollection(input: { collection_url: string; title: string; expected_model_count: number; models: Model[] }) {
    const url = makerworldUrl(input.collection_url, "collections");
    if (!input.title.trim() || input.models.length > 1000) throw new Error("Collection needs a title and at most 1000 models.");
    const models = new Map<string, Model>();
    for (const item of input.models) {
      const model: Model = { url: makerworldUrl(item.url, "models"), title: item.title.trim() };
      if (!model.title) throw new Error("Every collection model needs a title.");
      if (item.design_id) {
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(item.design_id)) throw new Error("Invalid MakerWorld design identifier.");
        model.design_id = item.design_id;
      }
      if (item.cover_url) {
        const cover = new URL(item.cover_url);
        if (cover.protocol !== "https:" || !["makerworld.bblmw.com", "makerworld.bblmw.cn"].includes(cover.hostname) || cover.username || cover.password)
          throw new Error("Collection cover must use MakerWorld's HTTPS media host.");
        model.cover_url = cover.href;
        model.design_id ??= /^\/makerworld\/model\/([a-zA-Z0-9_-]+)\//.exec(cover.pathname)?.[1];
      }
      models.set(model.url, model);
    }
    if (!Number.isInteger(input.expected_model_count) || input.expected_model_count !== models.size)
      throw new Error("Collection snapshot is incomplete or duplicated: expected_model_count must match the page's total and the unique observed models. Existing snapshot was preserved.");
    const collection: Collection = { url, title: input.title.trim(), observed_at: new Date().toISOString(), models: [...models.values()] };
    this.db.prepare("INSERT INTO makerworld_collections(url,record) VALUES (?,?) ON CONFLICT(url) DO UPDATE SET record=excluded.record").run(url, JSON.stringify(collection));
    return { source: "saved_browser_observation", live_makerworld: false, ...collection, model_count: models.size };
  }

  private collections(): Collection[] {
    return this.db.prepare("SELECT record FROM makerworld_collections ORDER BY url").all().map(row => JSON.parse(String(row.record)));
  }

  async scan(signal?: AbortSignal) {
    const files = new Set<string>();
    const warnings: Array<{ path: string; error: string }> = [];
    const visit = (directory: string) => {
      signal?.throwIfAborted();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile() && /\.(3mf|gcode|stl)$/i.test(entry.name)) files.add(fs.realpathSync(file));
        if (files.size > 1000) throw new Error("Print library exceeds 1000 files; configure narrower BAMBU_LIBRARY_DIRS roots.");
      }
    };
    for (const root of this.roots) {
      if (!fs.existsSync(root)) continue;
      try { visit(root); } catch (error) { signal?.throwIfAborted(); warnings.push({ path: root, error: (error as Error).message }); }
    }
    const records: SavedFile[] = [];
    for (const file of files) {
      signal?.throwIfAborted();
      try {
        const stat = fs.statSync(file);
        const fingerprint = `${METADATA_VERSION}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        const cached = this.db.prepare("SELECT fingerprint,record FROM library_files WHERE path=?").get(file);
        const record: SavedFile = cached?.fingerprint === fingerprint ? JSON.parse(String(cached.record)) : await inspectSavedFile(file);
        if (cached?.fingerprint !== fingerprint) this.db.prepare("INSERT INTO library_files(path,fingerprint,record) VALUES (?,?,?) ON CONFLICT(path) DO UPDATE SET fingerprint=excluded.fingerprint,record=excluded.record").run(file, fingerprint, JSON.stringify(record));
        records.push(record);
      } catch (error) { warnings.push({ path: file, error: (error as Error).message }); }
    }
    return { records, warnings };
  }

  private associated(file: SavedFile, model: Model): "design_id" | "title" | null {
    if (file.design_id && model.design_id) return file.design_id === model.design_id ? "design_id" : null;
    return file.title && normalized(file.title) === normalized(model.title) ? "title" : null;
  }

  async find(query = "", limit = 10, signal?: AbortSignal) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Library limit must be between 1 and 50.");
    const { records, warnings } = await this.scan(signal);
    const collections = this.collections();
    const models = new Map(collections.flatMap(collection => collection.models.map(model => [model.url, model] as const)));
    const url = query.startsWith("https://") ? makerworldUrl(query, "models") : null;
    const terms = normalized(query).split(" ").filter(Boolean);
    const matches = (text: string) => terms.every(term => normalized(text).includes(term));
    const modelMatches = [...models.values()].filter(model => url ? model.url === url : matches(`${model.title} ${model.url}`));
    const fileMatches = records.filter(file => modelMatches.some(model => this.associated(file, model)) || (!url && matches(`${file.path} ${file.title ?? ""} ${file.profile_title ?? ""}`)));
    const grouped = new Map<string, SavedFile[]>();
    for (const file of fileMatches) grouped.set(file.sha256, [...(grouped.get(file.sha256) ?? []), file]);
    const files = [...grouped.values()].map(copies => ({
      ...copies[0], paths: copies.map(file => file.path),
      matches: [...models.values()].flatMap(model => {
        const match = this.associated(copies[0], model);
        return match ? [{ url: model.url, title: model.title, match }] : [];
      }),
    })).sort((a, b) => Number(b.kind === "prepared_3mf" || b.kind === "gcode") - Number(a.kind === "prepared_3mf" || a.kind === "gcode") || b.modified_at.localeCompare(a.modified_at));
    return {
      evidence: "saved-collection-and-local-file-metadata", dispatch_authorized: false, live_makerworld: false,
      query, roots: this.roots, indexed_files: records.length, scan_incomplete: warnings.length > 0, warnings,
      collections: collections.map(({ models, ...collection }) => ({ ...collection, model_count: models.length })),
      model_matches: modelMatches.slice(0, limit), matching_models: modelMatches.length,
      files: files.slice(0, limit), matching_files: files.length,
      truncated: files.length > limit || modelMatches.length > limit,
    };
  }

  async details(filePath: string, printerFiles?: PrinterFile[], includePreview = false) {
    const file = await inspectSavedFile(filePath, includePreview);
    const matches = this.collections().flatMap(collection => collection.models.flatMap(model => {
      const match = this.associated(file, model);
      return match ? [{ ...model, match, collection_url: collection.url, collection_observed_at: collection.observed_at }] : [];
    }));
    const stored = printerFiles?.filter(remote => remote.name === path.basename(file.path) || remote.name.endsWith(`-${path.basename(file.path)}`))
      .map(remote => ({ ...remote, size_matches: remote.size === file.bytes })) ?? [];
    return { evidence: "file-metadata-only", dispatch_authorized: false, ...file, makerworld: matches,
      printer_storage: { checked: printerFiles !== undefined, matches: stored, evidence: "name-and-size-only", bytes_verified: false, handy_verified: false },
      next_step: file.kind === "source_project" || file.kind === "mesh" ? "Source only: prepare a compatible slice before sending." :
        "Reuse this slice if the selected plate, quantity and settings match. Inspect the exact file and fresh printer compatibility before sending; no new slice was generated." };
  }
}
