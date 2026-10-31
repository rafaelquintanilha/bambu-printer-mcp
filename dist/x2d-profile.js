import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
/** One local printer and slicer; credentials and executable paths belong to configuration. */
export function configureX2dEnvironment(env) {
    Object.assign(env, {
        MCP_TRANSPORT: "stdio",
        BAMBU_MODEL: "x2d",
        BAMBU_PRINTER_MODEL: "x2d",
        BAMBU_DEFAULT_CONNECTION_MODE: "bambu_native",
        BAMBU_REQUIRE_CONFIRMATION: "1",
        MCP_ALLOW_EXECUTABLE_ARG: "0",
        MCP_ALLOW_BRIDGE_COMMAND_ARG: "0",
        SLICER_TYPE: "bambustudio",
    });
}
const TOOL_NAMES = new Set([
    "get_printer_status", "get_printer_filaments", "resolve_3mf_ams_slots",
    "list_3mf_plate_objects", "camera_snapshot", "list_printer_files",
    "get_stl_info", "scale_stl", "rotate_stl", "extend_stl_base",
    "merge_vertices", "center_model", "lay_flat",
    "list_templates", "save_template", "get_slice_settings", "slice_with_template", "slice_stl",
    "inspect_print_file", "upload_file", "print_3mf", "delete_printer_file",
    "pause_print", "resume_print", "cancel_print", "clear_hms_errors",
    "x2d_native_control", "reread_ams_rfid", "set_ams_drying",
    "set_print_speed", "set_temperature", "set_fan_speed", "set_airduct_mode", "set_light", "skip_objects",
    "blender_mcp_status", "blender_mcp_call", "blender_mcp_edit_model",
]);
const CONFIGURATION_FIELDS = new Set([
    "host", "bambu_serial", "bambu_token", "bambu_model",
    "connection_mode", "connection_type", "bambu_network_method", "dev_id", "dev_ip",
    "bridge_command", "bambu_network_config_dir", "country_code", "user_info",
    "slicer_type", "slicer_path", "ffmpeg_path", "print", "experimental",
]);
const READ_ONLY_TOOLS = new Set([
    "get_printer_status", "get_printer_filaments", "resolve_3mf_ams_slots", "list_3mf_plate_objects",
    "list_printer_files", "get_stl_info", "list_templates", "get_slice_settings", "inspect_print_file",
]);
const DESCRIPTIONS = {
    get_printer_status: "Read the configured X2D's current job, progress, remaining time, temperatures and errors. Check job identity after sending a print; a dispatch receipt alone does not prove printing started.",
    get_printer_filaments: "Read the configured X2D's live AMS and external-spool inventory, colours, material types, and available Bambu Studio filament profiles.",
    inspect_print_file: "Inspect a private snapshot of a sliced file for the X2D, including selected plate, declared nozzles, materials and temperatures. Does not contact the printer or authorize printing.",
    slice_stl: "Slice an STL or 3MF for the X2D with the configured Bambu Studio installation. Supports process profiles, filament assignments, colours, orientation and plate selection. Returns a local artifact; does not upload or print.",
    slice_with_template: "Slice an STL or 3MF for the X2D with a saved template and the configured Bambu Studio installation. Does not upload or print.",
    upload_file: "Send a sliced file to the configured X2D's storage without starting a print. Inspect all printable plates and live printer compatibility before the native upload. Use print_3mf separately to start printing.",
    print_3mf: "Start an X2D print through Bambu's native networking library, with fresh hardware checks and human confirmation. Supports explicit AMS slots, plate selection and calibration. Auto-slices unsliced projects; use slice_stl first when reviewing the slice. Verify the returned printerJobName with get_printer_status after dispatch.",
};
/** Limit both discovery and invocation, including direct calls to unadvertised tools. */
export class X2dToolProfile {
    constructor(upstreamTools) {
        this.validators = new Map();
        this.defaults = new Map();
        const validator = new AjvJsonSchemaValidator();
        this.tools = upstreamTools.filter(tool => TOOL_NAMES.has(tool.name)).map(tool => {
            const original = tool.inputSchema.properties ?? {};
            const properties = Object.fromEntries(Object.entries(original).filter(([name]) => !CONFIGURATION_FIELDS.has(name)));
            const defaults = {};
            if (Object.prototype.hasOwnProperty.call(original, "bambu_model"))
                defaults.bambu_model = "x2d";
            if (Object.prototype.hasOwnProperty.call(original, "slicer_type"))
                defaults.slicer_type = "bambustudio";
            if (tool.name === "upload_file")
                Object.assign(defaults, { connection_mode: "bambu_native", print: false });
            if (tool.name === "print_3mf")
                defaults.connection_mode = "bambu_native";
            const inputSchema = {
                ...tool.inputSchema,
                properties,
                required: (tool.inputSchema.required ?? []).filter(name => !CONFIGURATION_FIELDS.has(name)),
                additionalProperties: false,
            };
            this.defaults.set(tool.name, defaults);
            this.validators.set(tool.name, validator.getValidator(inputSchema));
            return {
                ...tool,
                description: DESCRIPTIONS[tool.name] ?? tool.description,
                inputSchema,
                ...(READ_ONLY_TOOLS.has(tool.name) ? {
                    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
                } : {}),
            };
        });
        for (const name of TOOL_NAMES) {
            if (!this.validators.has(name))
                throw new Error(`X2D profile requires upstream tool ${name}.`);
        }
    }
    prepare(name, args) {
        const validate = this.validators.get(name);
        if (!validate)
            throw new McpError(ErrorCode.MethodNotFound, `Tool ${name} is not available in the X2D profile.`);
        const result = validate(args ?? {});
        if (!result.valid)
            throw new McpError(ErrorCode.InvalidParams, `Invalid ${name} arguments: ${result.errorMessage}`);
        return { ...result.data, ...this.defaults.get(name) };
    }
}
export function describeX2dResult(name, result) {
    if (name !== "print_3mf" || !result || typeof result !== "object" || !("status" in result) || result.status !== "success")
        return result;
    return {
        ...result,
        status: "dispatched",
        physicalPrintVerified: false,
        note: "The networking library accepted the dispatch. Read printer status and match printerJobName before reporting that printing started. Do not automatically resend an uncertain job.",
    };
}
