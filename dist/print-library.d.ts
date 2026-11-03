type Model = {
    url: string;
    title: string;
    design_id?: string;
    cover_url?: string;
};
type Plate = {
    number: number;
    object_count: number | null;
    objects: string[];
    estimated_seconds: number | null;
    estimated_grams: number | null;
};
type SavedFile = {
    path: string;
    sha256: string;
    bytes: number;
    modified_at: string;
    kind: "prepared_3mf" | "source_project" | "gcode" | "mesh";
    title: string | null;
    designer: string | null;
    design_id: string | null;
    profile_id: string | null;
    profile_title: string | null;
    printer_model: string | null;
    nozzles: string[];
    materials: string[];
    colors: string[];
    settings: Record<string, unknown>;
    plates: Plate[];
    preview_entry: string | null;
    preview?: {
        format: "image/png";
        base64: string;
        sizeBytes: number;
    };
};
type PrinterFile = {
    name: string;
    path: string;
    size: number;
};
export declare function makerworldUrl(raw: string, kind: "models" | "collections"): string;
/** File metadata is a discovery aid; exact print inspection remains independent. */
export declare function inspectSavedFile(filePath: string, includePreview?: boolean): Promise<SavedFile>;
export declare class PrintLibrary {
    readonly roots: string[];
    private readonly db;
    constructor(directory: string, roots: string[]);
    close(): void;
    saveCollection(input: {
        collection_url: string;
        title: string;
        expected_model_count: number;
        models: Model[];
    }): {
        model_count: number;
        url: string;
        title: string;
        observed_at: string;
        models: Model[];
        source: string;
        live_makerworld: boolean;
    };
    private collections;
    scan(signal?: AbortSignal): Promise<{
        records: SavedFile[];
        warnings: {
            path: string;
            error: string;
        }[];
    }>;
    private associated;
    find(query?: string, limit?: number, signal?: AbortSignal): Promise<{
        evidence: string;
        dispatch_authorized: boolean;
        live_makerworld: boolean;
        query: string;
        roots: string[];
        indexed_files: number;
        scan_incomplete: boolean;
        warnings: {
            path: string;
            error: string;
        }[];
        collections: {
            model_count: number;
            url: string;
            title: string;
            observed_at: string;
        }[];
        model_matches: Model[];
        matching_models: number;
        files: {
            paths: string[];
            matches: {
                url: string;
                title: string;
                match: "title" | "design_id";
            }[];
            path: string;
            sha256: string;
            bytes: number;
            modified_at: string;
            kind: "prepared_3mf" | "source_project" | "gcode" | "mesh";
            title: string | null;
            designer: string | null;
            design_id: string | null;
            profile_id: string | null;
            profile_title: string | null;
            printer_model: string | null;
            nozzles: string[];
            materials: string[];
            colors: string[];
            settings: Record<string, unknown>;
            plates: Plate[];
            preview_entry: string | null;
            preview?: {
                format: "image/png";
                base64: string;
                sizeBytes: number;
            };
        }[];
        matching_files: number;
        truncated: boolean;
    }>;
    details(filePath: string, printerFiles?: PrinterFile[], includePreview?: boolean): Promise<{
        makerworld: {
            match: "title" | "design_id";
            collection_url: string;
            collection_observed_at: string;
            url: string;
            title: string;
            design_id?: string;
            cover_url?: string;
        }[];
        printer_storage: {
            checked: boolean;
            matches: {
                size_matches: boolean;
                name: string;
                path: string;
                size: number;
            }[];
            evidence: string;
            bytes_verified: boolean;
            handy_verified: boolean;
        };
        next_step: string;
        path: string;
        sha256: string;
        bytes: number;
        modified_at: string;
        kind: "prepared_3mf" | "source_project" | "gcode" | "mesh";
        title: string | null;
        designer: string | null;
        design_id: string | null;
        profile_id: string | null;
        profile_title: string | null;
        printer_model: string | null;
        nozzles: string[];
        materials: string[];
        colors: string[];
        settings: Record<string, unknown>;
        plates: Plate[];
        preview_entry: string | null;
        preview?: {
            format: "image/png";
            base64: string;
            sizeBytes: number;
        };
        evidence: string;
        dispatch_authorized: boolean;
    }>;
}
export {};
