import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types";
import { ErrorCode, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";

/** One local printer and slicer; credentials and executable paths belong to configuration. */
export function configureX2dEnvironment(env: NodeJS.ProcessEnv): void {
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

// Each tool definition is sent to the model on every turn, so the profile keeps
// one tool per job. slice_stl covers scaling, rotation, orientation and bed
// placement, and get_saved_print_details reads STL files, so the STL editing
// tools are left out; so are the template registry, Blender and print_3mf,
// which duplicates prepare_print. The generic server keeps all of them.
const TOOL_NAMES = new Set([
  "get_printer_status", "get_printer_filaments", "resolve_3mf_ams_slots",
  "list_3mf_plate_objects", "camera_snapshot", "list_printer_files",
  "get_slice_settings", "slice_stl",
  "inspect_print_file", "upload_file", "delete_printer_file",
  "pause_print", "resume_print", "cancel_print", "clear_hms_errors",
  "x2d_native_control", "reread_ams_rfid", "set_ams_drying",
  "set_print_speed", "set_temperature", "set_fan_speed", "set_airduct_mode", "set_light", "skip_objects",
]);

const CONFIGURATION_FIELDS = new Set([
  "host", "bambu_serial", "bambu_token", "bambu_model",
  "connection_mode", "connection_type", "bambu_network_method", "dev_id", "dev_ip",
  "bridge_command", "bambu_network_config_dir", "country_code", "user_info",
  "slicer_type", "slicer_path", "ffmpeg_path", "print", "experimental",
]);

/** Fields of the template registry and a duplicate alias, unused with the X2D profile. */
const OMITTED_FIELDS = new Set(["template_name", "template_dir", "filament_profile"]);

const READ_ONLY_TOOLS = new Set([
  "get_printer_status", "get_printer_filaments", "resolve_3mf_ams_slots", "list_3mf_plate_objects",
  "list_printer_files", "get_slice_settings", "inspect_print_file",
  "get_connector_info", "get_print_history",
  "find_saved_prints", "get_saved_print_details",
]);

const DESCRIPTIONS: Record<string, string> = {
  get_printer_status: "Read a compact X2D status with job IDs, stage, progress, remaining minutes, temperatures, errors and MQTT observation age. Fresh observations update durable job history, including prints started outside this connector. Stale data is labeled; this display is not safety authorization. Set include_raw only for detailed diagnosis. Check job identity and camera after dispatch.",
  get_printer_filaments: "Read the configured X2D's live AMS and external-spool inventory, colours, material types, and available Bambu Studio filament profiles.",
  inspect_print_file: "Inspect a private snapshot of a sliced file for the X2D, including selected plate, declared nozzles, materials and temperatures. Does not contact the printer or authorize printing.",
  slice_stl: "Slice an STL or 3MF for the X2D with the configured Bambu Studio installation. Agree with the user on model, quantity and color before slicing, then read get_printer_filaments to select the intended spool. Supports process profiles, filament assignments, colours, orientation and plate selection. Returns a local artifact; does not upload or print.",
  slice_with_template: "Slice an STL or 3MF for the X2D with a saved template and the configured Bambu Studio installation. Agree with the user on model, quantity and color and read the live filament inventory first. Does not upload or print.",
  upload_file: "Send a sliced file to X2D internal storage without starting a print, including while another job runs. Inspect every printable plate and live printer compatibility, use a unique name, then read back and verify all bytes and checksums before reporting success. Returns the actual internal path. Use prepare_print and confirm_print separately to start printing.",
  list_printer_files: "List model files in X2D internal storage through Bambu Studio's file service, including printer paths, byte sizes and timestamps. Does not start or change a print. External SD/USB files and logs are not included.",
  prepare_print: "Prepare an X2D print review without uploading, heating or starting. Ask the user for model, quantity and color before slicing. Returns the exact job, selected spool colors, camera image and a one-use approval_id. Obtain the user's explicit approval, visually check the camera, then call confirm_print.",
};

/** Limit both discovery and invocation, including direct calls to unadvertised tools. */
export class X2dToolProfile {
  readonly tools: Tool[];
  private readonly validators = new Map<string, JsonSchemaValidator<Record<string, unknown>>>();
  private readonly defaults = new Map<string, Record<string, unknown>>();

  constructor(upstreamTools: Tool[]) {
    const validator = new AjvJsonSchemaValidator();
    const print = upstreamTools.find(tool => tool.name === "print_3mf");
    if (!print) throw new Error("X2D profile requires upstream tool print_3mf.");
    upstreamTools = [...upstreamTools, {
      name: "get_connector_info",
      description: "Inspect the running connector build, restart requirement and selected print route. Set check_connections for read-only authenticated cloud and local file-list checks. Reports each route separately; authentication and file access do not prove print submission. Never uploads or starts a job.",
      inputSchema: { type: "object", properties: { check_connections: { type: "boolean", default: false } } },
    }, {
      name: "get_print_history",
      description: "Read the configured printer's saved job observations across connector restarts. Includes jobs first seen from Studio, Handy or other clients; their source app is not inferred. Read get_printer_status first for a live update. Only observed terminal states establish finish/failure; missing endings remain unknown. Does not start, resume or schedule prints.",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } } },
    }, {
      name: "save_makerworld_collection",
      description: "Save a complete collection snapshot read from the user's authenticated MakerWorld Chrome session. Supply observed model URLs, titles and optional cover URLs/design IDs. Replaces this collection's cached membership; does not modify MakerWorld, download, slice, contact the printer or start a print. Never invent account content. Results are labeled as saved browser observations.",
      inputSchema: { type: "object", properties: {
        collection_url: { type: "string", minLength: 1, maxLength: 2000 }, title: { type: "string", minLength: 1, maxLength: 300 },
        expected_model_count: { type: "integer", minimum: 0, maximum: 1000, description: "Total model count shown by the collection page. Load all entries before saving; incomplete snapshots are rejected." },
        models: { type: "array", maxItems: 1000, items: { type: "object", additionalProperties: false, properties: {
          url: { type: "string", minLength: 1, maxLength: 2000 }, title: { type: "string", minLength: 1, maxLength: 300 },
          design_id: { type: "string", maxLength: 100 }, cover_url: { type: "string", maxLength: 3000 },
        }, required: ["url", "title"] } },
      }, required: ["collection_url", "title", "expected_model_count", "models"] },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, {
      name: "find_saved_prints",
      description: "Find saved MakerWorld models and existing local print files BEFORE downloading or slicing. Query by name or MakerWorld model URL. Uses cached collection observations and configured BAMBU_LIBRARY_DIRS, extracts identity/settings/estimates without a slicer, caches unchanged metadata, and groups byte-identical copies. Distinguishes prepared slices from sources and design-ID from title matches. Does not browse MakerWorld, contact the printer, authorize printing or verify Handy availability.",
      inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 2000, default: "" }, limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } } },
    }, {
      name: "get_saved_print_details",
      description: "Read a saved .3mf, .gcode or .stl into a compact report: source/prepared state, identity, plates, objects, colors, nozzles, support settings and estimates. Never slices. Optional check_printer_storage reads the internal listing and reports filename matches and byte-size agreement; this is not current checksum verification or proof of Handy visibility. Inspect the exact prepared file before upload. Does not upload or start a print.",
      inputSchema: { type: "object", properties: { file_path: { type: "string", minLength: 1 }, check_printer_storage: { type: "boolean", default: false }, include_preview: { type: "boolean", default: true, description: "Return the saved plate PNG as MCP image content when present, without slicing." } }, required: ["file_path"] },
    }, {
      ...print, name: "prepare_print",
    }, {
      name: "confirm_print",
      description: "Start exactly one prepared X2D job AFTER the user explicitly approves its model, quantity and selected colors in chat. Copy the user's affirmative reply verbatim; never infer consent from silence or from preparing a job. Visually inspect the returned camera image, or a newer camera_snapshot, and set plate_clear only if the whole plate is visibly clear; ask the user if obstructed or ambiguous. Approval expires in 10 minutes; camera must be under 2 minutes old. A token works once, including failed attempts. Rechecks file, printer, job, nozzles, errors and selected spool colors before native dispatch. Never automatically retry an uncertain dispatch; verify printerJobName in status and camera.",
      inputSchema: {
        type: "object",
        properties: {
          approval_id: { type: "string", minLength: 1, description: "The approval_id returned by prepare_print for the exact reviewed job." },
          user_approved: { type: "boolean", const: true, description: "True only after the user explicitly approves the reviewed job in chat." },
          user_approval: { type: "string", minLength: 1, maxLength: 2000, description: "The user's actual affirmative reply, copied verbatim. This is a trusted-client attestation, not server-authenticated proof of human identity." },
          camera_capture_id: { type: "string", minLength: 1, description: "The capture_id of the image you inspected, taken at or after job preparation and less than two minutes ago." },
          plate_clear: { type: "boolean", const: true, description: "True only after visually checking the fresh camera image and seeing a clear plate. An uncertain or obstructed image cannot satisfy this check." },
        },
        required: ["approval_id", "user_approved", "user_approval", "camera_capture_id", "plate_clear"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }];
    this.tools = upstreamTools.filter(tool => TOOL_NAMES.has(tool.name) || ["prepare_print", "confirm_print", "get_connector_info", "get_print_history", "save_makerworld_collection", "find_saved_prints", "get_saved_print_details"].includes(tool.name)).map(tool => {
      const original = tool.inputSchema.properties ?? {};
      const properties = Object.fromEntries(Object.entries(original).filter(([name]) => !CONFIGURATION_FIELDS.has(name) && !OMITTED_FIELDS.has(name)));
      if (tool.name === "get_printer_status") properties.include_raw = { type: "boolean", default: false, description: "Include full MQTT telemetry for diagnosis; normally omit to keep responses compact." };
      const defaults: Record<string, unknown> = {};
      if (Object.prototype.hasOwnProperty.call(original, "bambu_model")) defaults.bambu_model = "x2d";
      if (Object.prototype.hasOwnProperty.call(original, "slicer_type")) defaults.slicer_type = "bambustudio";
      if (tool.name === "upload_file") Object.assign(defaults, { connection_mode: "bambu_native", print: false });
      if (tool.name === "prepare_print") defaults.connection_mode = "bambu_native";
      const inputSchema: Tool["inputSchema"] = {
        ...tool.inputSchema,
        properties,
        required: (tool.inputSchema.required ?? []).filter(name => !CONFIGURATION_FIELDS.has(name) && !OMITTED_FIELDS.has(name)),
        additionalProperties: false,
      };
      this.defaults.set(tool.name, defaults);
      this.validators.set(tool.name, validator.getValidator<Record<string, unknown>>(inputSchema));
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
      if (!this.validators.has(name)) throw new Error(`X2D profile requires upstream tool ${name}.`);
    }
  }

  prepare(name: string, args: unknown): Record<string, unknown> {
    const validate = this.validators.get(name);
    if (!validate) throw new McpError(ErrorCode.MethodNotFound, `Tool ${name} is not available in the X2D profile.`);
    const result = validate(args ?? {});
    if (!result.valid) throw new McpError(ErrorCode.InvalidParams, `Invalid ${name} arguments: ${result.errorMessage}`);
    return { ...result.data, ...this.defaults.get(name) };
  }
}

export function describeX2dResult(name: string, result: unknown): unknown {
  if (name !== "confirm_print" || !result || typeof result !== "object" || !("status" in result) || result.status !== "success") return result;
  return {
    ...result,
    status: "dispatched",
    physicalPrintVerified: false,
    note: "The networking library accepted the dispatch. Read printer status and match printerJobName before reporting that printing started. Do not automatically resend an uncertain job.",
  };
}
