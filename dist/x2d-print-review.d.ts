import type { PrintPreflight } from "./printers/bambu.js";
import type { PrintFileInspection } from "./safety/print-file.js";
import type { PrinterStateRequirements, ValidatedPrinterState } from "./safety/printer-state.js";
/** Call only after inspecting the snapshot's archive and G-code. */
export declare function printReviewDetails(snapshot: string, plateIndex: number): Promise<{
    object_count: number;
    objects: {
        id: number;
        name: string;
    }[];
    estimated_seconds: number | null;
    estimated_grams: number | null;
}>;
/** Only fields relevant to the reviewed job; cooling temperatures are allowed to change. */
export declare function printReviewState(status: any, checked: ValidatedPrinterState, requirements: PrinterStateRequirements): {
    model: string;
    serial: any;
    previousJob: any[];
    nozzles: {
        index: number;
        diameter: number;
        type: string | undefined;
        flow: string | undefined;
    }[];
    plate: any[];
    filaments: {
        filamentPosition: number;
        slot: number | undefined;
        material: any;
        color: any;
        profile: any;
        tag: any;
        spool: any;
    }[];
};
export type PrintReviewState = ReturnType<typeof printReviewState>;
export type PrintReview = {
    id: string;
    createdAt: number;
    expiresAt: number;
    host: string;
    serial: string;
    args: Record<string, any>;
    inspection: PrintFileInspection;
    state: PrintReviewState;
    preflight: PrintPreflight;
};
export type CameraEvidence = {
    id: string;
    capturedAt: number;
    host: string;
    serial: string;
};
export type ApprovedPrint = {
    review: PrintReview;
    camera: CameraEvidence;
    userApproval: string;
};
/** One pending job per local X2D session. Chat approval is a trusted-client attestation. */
export declare class X2dPrintReviews {
    private readonly now;
    private pending?;
    private camera?;
    constructor(now?: () => number);
    invalidate(): void;
    recordCamera(host: string, serial: string): CameraEvidence;
    prepare(input: Omit<PrintReview, "id" | "createdAt" | "expiresAt">): PrintReview;
    consume(args: Record<string, any>): ApprovedPrint;
    assertFresh(approved: ApprovedPrint): void;
    assertMatches(approved: ApprovedPrint, host: string, serial: string, inspection: PrintFileInspection, state: PrintReviewState): void;
}
