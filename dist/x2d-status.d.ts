/** Display data only. Print/heater safety always uses independent fresh telemetry. */
export declare function compactX2dStatus(status: any, now?: number): {
    schema_version: number;
    status: any;
    connected: boolean;
    model: any;
    serial: any;
    observation: {
        source: string;
        observed_at: string | null;
        age_ms: number | null;
        stale: boolean;
        received_after_request: boolean;
    };
    print: {
        filename: any;
        task_id: string | null;
        subtask_id: string | null;
        job_id: string | null;
        file: any;
        identity_quality: string;
        stage: string;
        stage_code: number | null;
        progress: number | null;
        timeRemaining: number | null;
        time_remaining_unit: string;
        currentLayer: number | null;
        totalLayers: number | null;
    };
    temperatures: any;
    active_ams_slot: number | null;
    errors: {
        connection_error?: string | undefined;
        print_error: number | null;
        hms: any;
        fail_reason: any;
    };
};
export type X2dStatus = ReturnType<typeof compactX2dStatus>;
type StoredJob = {
    id: string;
    identity: string;
    first_observed_at: string;
    last_observed_at: string;
    terminal_observed_at: string | null;
    outcome: "finished" | "failed" | "cancelled" | "unknown" | null;
    latest: X2dStatus;
};
/** Local SQLite transactions keep simultaneous MCP sessions from losing observations. */
export declare class X2dJobHistory {
    readonly directory: string;
    private readonly db;
    constructor(directory: string);
    close(): void;
    observe(status: X2dStatus): {
        recorded: boolean;
        reason: string;
        current_job_id: string | number | bigint | NodeJS.NonSharedUint8Array | null;
    } | {
        recorded: boolean;
        current_job_id: string | null;
        reason?: undefined;
    };
    list(serial: string, limit?: number): {
        source: string;
        live_status: boolean;
        last_observed_at: string | null;
        last_observed_job_id: string | number | bigint | NodeJS.NonSharedUint8Array | null;
        jobs: StoredJob[];
    };
}
/** Hash the loaded distribution at startup so later disk changes require an explicit restart. */
export declare function connectorBuildId(directory: string): string;
export {};
