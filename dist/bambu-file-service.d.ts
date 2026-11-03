import { type BambuNativeExecution, type BambuNativeUpdateCallback } from "./bambu-native.js";
type Connection = {
    host: string;
    token: string;
};
export type InternalPrinterFile = {
    name: string;
    path: string;
    size: number;
    time?: number | string;
};
export declare class BambuFileServiceError extends Error {
    readonly phase: string;
    readonly uploadStarted: boolean;
    readonly retryable = false;
    readonly route = "local-file-service";
    readonly nativeStage: string | null;
    readonly nativeCode: number | null;
    readonly recovery: string;
    constructor(message: string, phase: string, uploadStarted: boolean);
    details(): {
        route: string;
        phase: string;
        native_stage: string | null;
        native_code: number | null;
        upload_started: boolean;
        print_requested: boolean;
        retryable: boolean;
        recovery: string;
    };
}
export declare function listInternalPrinterFiles(connection: Connection, execution?: BambuNativeExecution): Promise<{
    files: string[];
    directories: {
        internal: string[];
    };
    entries: InternalPrinterFile[];
    storage: string;
}>;
export declare function uploadInternalPrinterFile(connection: Connection & {
    filePath: string;
    remoteName: string;
}, onUpdate?: BambuNativeUpdateCallback, execution?: BambuNativeExecution): Promise<{
    remotePath: string;
    remoteName: string;
    storage: string;
    bytes: number;
    sha256: string;
    md5: string;
    downloadVerified: boolean;
}>;
export {};
