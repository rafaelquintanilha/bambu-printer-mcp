# X2D workflow

`bambu-x2d-mcp` provides a local, single-printer workflow through MCP. It uses the upstream Bambu transport, slicer and file-inspection implementations while fixing the target model to X2D and the slicer to Bambu Studio.

## Capabilities

| Work | Tools |
| --- | --- |
| Inspect and edit models | `get_stl_info`, `scale_stl`, `rotate_stl`, `extend_stl_base`, `merge_vertices`, `center_model`, `lay_flat` |
| Create and edit complex geometry | The MCP client's existing Blender integration, or this server's optional `blender_mcp_status`, `blender_mcp_call` and `blender_mcp_edit_model` bridge |
| Prepare a print | `get_slice_settings`, `list_templates`, `save_template`, `slice_with_template`, `slice_stl`, `list_3mf_plate_objects`, `inspect_print_file` |
| Choose and manage filament | `get_printer_filaments`, `resolve_3mf_ams_slots`, `x2d_native_control`, `reread_ams_rfid`, `set_ams_drying` |
| Send and print | `upload_file`, `print_3mf`, `list_printer_files`, `delete_printer_file` |
| Monitor and control | `get_printer_status`, `camera_snapshot`, `pause_print`, `resume_print`, `cancel_print`, `clear_hms_errors`, `set_print_speed`, `set_temperature`, `set_fan_speed`, `set_airduct_mode`, `set_light`, `skip_objects` |

Model creation uses Blender; the server's built-in mesh tools edit existing STL files. The optional Blender bridge needs its own configuration and a running Blender addon. See the upstream [setup guide](SETUP.md) for those requirements. No bridge is needed when the MCP client already has a Blender integration.

Status includes job identity, progress, remaining time, current layer and temperatures. Camera snapshots need `ffmpeg`. Status is retrieved on request; continuous monitoring or notifications are the MCP client's responsibility.

Camera snapshots also require **LAN Only Liveview** to be enabled on the printer's touchscreen. This camera setting is separate from LAN Only Mode; cloud liveview in Bambu Studio can work while the local camera feed is disabled. The MCP uses authenticated RTSPS on port 322. Port 6000 on the X2D serves file transfers and is not a camera fallback. If capture fails and the printer reports `ipcam.rtsp_url: "disable"`, the tool explains which setting to enable.

AMS slots are read live, rather than assuming a permanent colour or material in a slot. `resolve_3mf_ams_slots` matches a sliced project's filaments to the current inventory. `x2d_native_control` can update filament metadata using the upstream validated command format. Metadata changes do not physically load a different spool. Drying and other controls remain subject to installed hardware and upstream support. Manual positive nozzle heating is refused when the upstream checks cannot verify the active X2D nozzle/material.

## Local installation

Use Node.js 24, Bambu Studio with its networking plug-in, and Apple's command-line developer tools on macOS. From this repository:

```sh
npm ci
npm run build
npm run build:native
```

If Apple clang and the automatically chosen SDK do not match, select the active Xcode SDK for the build only:

```sh
SDKROOT="$(xcrun --sdk macosx --show-sdk-path)" npm run build:native
```

Configure the MCP client to launch `node` with the absolute path to `dist/x2d.js`. Supply the following values through its private environment configuration:

```text
PRINTER_HOST=<printer LAN IP>
BAMBU_SERIAL=<printer serial>
BAMBU_TOKEN=<printer LAN access code>
```

The host must be able to reach the printer's local network. Credentials are configured once and are absent from tool arguments. Keep them out of source files, Git and chat. No account login is required by this local connection, but printer firmware/network settings must permit it.

Set `TEMP_DIR` to a dedicated, private output directory if generated models and slices should survive server shutdown. Without it, the server uses temporary storage that it removes on exit. Keep original design files separately.

The executable always uses stdio, X2D, Bambu Studio, the native print/upload route and human print/heating confirmation. HTTP selection, other printer targets and per-call executable/credential overrides are rejected or overridden by the fixed profile. `SLICER_PATH`, `FFMPEG_PATH`, native-helper paths and Blender configuration remain trusted local installation settings. The generic upstream executable is `dist/index.js`; it does not have these profile restrictions unless `MCP_PROFILE=x2d` is set.

## Sending versus printing

1. Create or edit the model and preserve a separate source file for later revisions.
2. Read the AMS inventory and inspect the intended process/filament settings.
3. Call `slice_stl` or `slice_with_template`, then `inspect_print_file` on the resulting sliced file. Review the preview in Bambu Studio when visual verification is needed.
4. Call `upload_file` to send the sliced file to storage. This tool cannot start a print; a `print` argument is rejected. Its result reports the generated remote path and `printRequested: false`.
5. Call `print_3mf` with the local file and selected `ams_slots` when a print is requested. The native route uploads its own checked snapshot and dispatches it; it does not start the previously uploaded storage entry by name. The upstream hardware checks and human confirmation still apply.
6. A `dispatched` result means the networking library accepted the command. It includes `printerJobName` and `physicalPrintVerified: false`. Read `get_printer_status` and match that job before reporting that printing started. Never automatically resend an uncertain dispatch.

`print_3mf` retains upstream auto-slicing for unsliced projects. Slice explicitly first when the generated settings need review. File listing/deletion uses upstream FTPS and does not guarantee visibility into internal eMMC storage.

## Compatibility and trust

This profile retains upstream's file, temperature, nozzle, AMS and fresh-state checks. It also validates each public tool's input schema and rejects calls to tools outside the profile. Printer resources cannot select a different host.

The native helper relies on Bambu's proprietary networking plug-in. Rebuild after updating the package and revalidate compatibility after Bambu Studio/Connect updates. The macOS path does not pin the vendor library's binary interface. Upstream MQTT certificate verification remains disabled; use a trusted local network. Stdio removes the HTTP endpoint but does not change that printer-network trust assumption.

Preserve the upstream GPL-2.0 license and contributor attribution. Upstream updates can be merged without replacing the X2D entry point or its tests.
