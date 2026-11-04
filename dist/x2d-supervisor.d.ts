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
/** Cheap fingerprint of the loaded JavaScript plus the newest write time. */
export declare function distSignature(directory: string): {
    signature: string;
    newestMs: number;
};
export declare function runX2dSupervisor(options: SupervisorOptions): Promise<number>;
