import { type Tool } from "@modelcontextprotocol/sdk/types.js";
/** One local printer and slicer; credentials and executable paths belong to configuration. */
export declare function configureX2dEnvironment(env: NodeJS.ProcessEnv): void;
/** Limit both discovery and invocation, including direct calls to unadvertised tools. */
export declare class X2dToolProfile {
    readonly tools: Tool[];
    private readonly validators;
    private readonly defaults;
    constructor(upstreamTools: Tool[]);
    prepare(name: string, args: unknown): Record<string, unknown>;
}
export declare function describeX2dResult(name: string, result: unknown): unknown;
