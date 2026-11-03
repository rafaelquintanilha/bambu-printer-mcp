import type { PrintFileInspection } from "./safety/print-file.js";
import type { PrintReviewState } from "./x2d-print-review.js";
export declare function decodeStudioSession(bytes: Buffer): Record<string, any>;
/** Read the explicitly selected Studio profile without opening or modifying Studio. */
export declare function readStudioCloudSession(directory?: string | undefined): Promise<{
    directory: string;
    encoded: NonSharedBuffer;
    session: Record<string, any>;
    version: string;
    deviceId: string;
    country: string;
}>;
export declare function verifyCloudPrinter(serial: string, signal?: AbortSignal, profile?: Awaited<ReturnType<typeof readStudioCloudSession>>): Promise<{
    authenticated: boolean;
    printer_matched: boolean;
    online: boolean;
    model: any;
    checked_at: string;
    submission: string;
    physical_print: string;
}>;
/** A disposable copy prevents the native agent from updating Studio's own login. */
export declare function withStudioCloudSession<T>(serial: string, signal: AbortSignal | undefined, operation: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T>;
/** Derive cloud mappings from the checked snapshot and observed selected spools. */
export declare function cloudPrintMetadata(snapshot: string, inspection: PrintFileInspection, state: PrintReviewState): Promise<{
    nozzleMapping: string;
    nozzlesInfo: string;
    amsMappingInfo: string;
}>;
