# X2D workflow

`bambu-x2d-mcp` provides a local, single-printer workflow through MCP. It uses the upstream Bambu transport, slicer and file-inspection implementations while fixing the target model to X2D and the slicer to Bambu Studio.

## Capabilities

| Work | Tools |
| --- | --- |
| Inspect and edit models | `get_stl_info`, `scale_stl`, `rotate_stl`, `extend_stl_base`, `merge_vertices`, `center_model`, `lay_flat` |
| Create and edit complex geometry | The MCP client's existing Blender integration, or this server's optional `blender_mcp_status`, `blender_mcp_call` and `blender_mcp_edit_model` bridge |
| Prepare a print | `get_slice_settings`, `list_templates`, `save_template`, `slice_with_template`, `slice_stl`, `list_3mf_plate_objects`, `inspect_print_file` |
| Choose and manage filament | `get_printer_filaments`, `resolve_3mf_ams_slots`, `x2d_native_control`, `reread_ams_rfid`, `set_ams_drying` |
| Send and print | `upload_file`, `prepare_print`, `confirm_print`, `print_3mf` (review alias), `list_printer_files`, `delete_printer_file` |
| Monitor and control | `get_printer_status`, `camera_snapshot`, `pause_print`, `resume_print`, `cancel_print`, `clear_hms_errors`, `set_print_speed`, `set_temperature`, `set_fan_speed`, `set_airduct_mode`, `set_light`, `skip_objects` |
| Inspect the connector and saved jobs | `get_connector_info`, `get_print_history` |

Model creation uses Blender; the server's built-in mesh tools edit existing STL files. The optional Blender bridge needs its own configuration and a running Blender addon. See the upstream [setup guide](SETUP.md) for those requirements. No bridge is needed when the MCP client already has a Blender integration.

Status includes job identity, stage, progress, remaining minutes, current layer, temperatures and errors. Camera snapshots need `ffmpeg` and return an MCP image with separate capture metadata; image bytes are not repeated as text. Status is retrieved on request; continuous monitoring or notifications are the MCP client's responsibility.

## Status, diagnostics and job history

`get_printer_status` and the status resource return compact display data. Use `include_raw: true` on the tool only when full MQTT telemetry is needed for diagnosis. Exact repeated firmware-module reports are deduplicated; conflicting identities remain visible. The generic upstream profile retains its full status response.

`observation.observed_at` records receipt of printer telemetry, not the time the status tool was called. Data older than 30 seconds, a disconnected printer, or an unknown receipt time is marked stale. `received_after_request` distinguishes a report received during this request from a recent cached report. Firmware-version messages do not refresh the telemetry timestamp. Display freshness does not replace the independent fresh-state checks required for printer commands.

Fresh status observations also update a private local SQLite job history. It recognizes jobs by the printer's task/subtask identifiers, including jobs started outside MCP. When those identifiers are unavailable, it uses the reported filename and marks the identity quality accordingly. A repeated filename after an observed terminal state is recorded as a new run. The originating application is not inferred.

`get_print_history` reads saved observations without contacting the printer; call `get_printer_status` first when a current update is needed. Only an observed `FINISH` or `FAILED` state records a terminal outcome. A job replaced by another job or an idle state without a terminal report has an unknown outcome. Observation timestamps do not claim the exact physical start or finish time, and the history does not grant permission to reprint.

History retains the latest 100 observed runs per printer. `get_print_history` returns ten by default and accepts `limit` from 1 to 50. It uses Node.js 24's built-in SQLite support and survives connector restarts. Set `BAMBU_STATE_DIR` to choose the private state directory; the default is `$XDG_STATE_HOME/bambu-x2d`, or `~/.local/state/bambu-x2d` when that variable is unset. This storage is separate from temporary model/slicer files. A storage failure is reported under `tracking` without hiding live status.

`get_connector_info` reports the running package version, distribution fingerprint, process start time, tool names and native-transport prerequisites without contacting the printer. It compares the running fingerprint with the current files on disk and sets `restart_required` when a reload is needed. Native prerequisites do not prove that protected commands or physical printing work. Call this tool after updating to check the advertised tools and the loaded build.

`bambu-x2d-mcp` (`dist/x2d.js`) runs a small supervisor that keeps the client's MCP connection and runs the server as a child process. Before forwarding a new request, it checks whether the built files changed. When they did, the build has settled and no request is in flight, it starts a server on the new build, repeats the client's MCP handshake, and retires the old server. The client does not reconnect. A crashed server is replaced on the next request. A request it left unanswered returns an error saying an upload or print outcome is uncertain, and nothing is resent. Pending print reviews belong to one server, so a reload invalidates them; prepare the review again. `BAMBU_X2D_RELOAD_SETTLE_MS` sets how long the newest built file must be unchanged before it loads (default 1500). Set `BAMBU_X2D_HOT_RELOAD=0` to run the server directly. A connector started before this supervisor existed must be restarted once.

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

Set `BAMBU_NATIVE_LAN_ONLY=0` when the printer remains paired with Bambu Cloud, or `BAMBU_NATIVE_LAN_ONLY=1` when the printer is configured in LAN-only mode. This selects the networking plug-in's device-certificate provisioning path; it does not change the printer's mode. A local connection through a VPN or subnet router still uses `0` for a cloud-paired printer. The helper defaults to `1`, so cloud-paired installations must set this explicitly.

Set `TEMP_DIR` to a dedicated, private output directory if generated models and slices should survive server shutdown. Without it, the server uses temporary storage that it removes on exit. Keep original design files separately.

The executable always uses stdio, X2D, Bambu Studio and the native print/upload route. Printing uses explicit chat approval and camera clearance as described below. Positive heating and hardware-error clearing retain MCP form confirmation. HTTP selection, other printer targets and per-call executable/credential overrides are rejected or overridden by the fixed profile. `SLICER_PATH`, `FFMPEG_PATH`, native-helper paths and Blender configuration remain trusted local installation settings. The generic upstream executable is `dist/index.js`; it retains its original elicitation-based print confirmation unless `MCP_PROFILE=x2d` is set.

## Sending versus printing

### Find and reuse a saved slice

Use `find_saved_prints` with a model name or MakerWorld model URL before downloading or slicing. Configure `BAMBU_LIBRARY_DIRS` with local model/slice directories, separated by `:` on macOS/Linux or `;` on Windows. The default root is `TEMP_DIR`. Metadata is cached in a private `library.sqlite` under `BAMBU_STATE_DIR`; changed files are refreshed, missing files disappear from current results, and identical copies are grouped by SHA-256. Scan failures are reported under `warnings` and `scan_incomplete`.

`save_makerworld_collection` stores a collection read through the user's authenticated Chrome session. Supply its URL, title, the page's `expected_model_count`, and every observed model URL/title; optional cover URLs or design IDs improve matching. The unique model count must match the page total, so a partial list cannot replace a complete snapshot. This saves a local observation only: it does not log into, scrape, or change MakerWorld. Collection results include their observation time and `live_makerworld: false`. Refresh through Chrome when current membership is needed.

Embedded 3MF design IDs link prepared slices to collection models even after filenames or titles change. When a design ID is unavailable, exact normalized title matches are labeled `title`; these are discovery candidates. Conflicting design IDs do not match by title. Different process settings remain separate variants. Source projects without G-code are distinguished from prepared slices.

`get_saved_print_details` reads a file's identity, plate objects, material/colors, nozzles, support settings, preview entry and time/weight estimates without running a slicer. Set `check_printer_storage: true` to include matching internal filenames and byte-size agreement. A name/size match does not verify current remote bytes or availability in Bambu Handy, and the response explicitly preserves those limits. Exact-file inspection and fresh printer compatibility checks still apply before transfer.

### Transfer and start

1. Agree on the model, quantity and color with the user before slicing. Create or edit the model and preserve a separate source file for later revisions.
2. Read the AMS inventory and match the chosen color and material to an explicit physical slot. Inspect the intended process/filament settings; do not silently choose the first loaded spool.
3. Call `slice_stl` or `slice_with_template`, then `inspect_print_file` on the resulting sliced file. Review the preview in Bambu Studio when visual verification is needed.
4. Call `upload_file` to send the sliced file to internal storage. This tool cannot start a print; a `print` argument is rejected. It checks every printable plate and fresh printer compatibility, uses a unique name, refuses overwrites, and reads the complete stored file back to verify its size, SHA-256 and printer MD5. Its result includes the actual `remotePath`, `storage: "internal"`, `downloadVerified: true`, and `printRequested: false`. Uploading can run while another job prints.
5. Call `prepare_print` with the local file and selected `ams_slots`. It inspects the exact file snapshot, reads fresh printer state and captures the camera. It returns `awaiting_confirmation`, a review of the selected plate's objects, spool colors, estimates and settings, and an `approval_id`. This call cannot upload, heat or start a job. In this dedicated profile, `print_3mf` is an alias for preparation and likewise cannot start a print.
6. Show the review to the user and obtain explicit approval for that job. Visually inspect the returned camera image for a clear plate. A clear image can establish clearance remotely; an obstructed or ambiguous image requires a new view or a user check. The server does not perform image recognition. The image does not verify physical spool contents or unchipped nozzle hardware; those remain configured declarations compared with the slice.
7. Call `confirm_print` with the `approval_id`, `user_approved: true`, the user's actual affirmative reply in `user_approval`, the inspected `camera_capture_id`, and `plate_clear: true`. No file, color, plate or calibration overrides are accepted. This explicit handoff replaces the print confirmation form for clients that cannot display MCP elicitation. It is a trusted-client attestation of the user's consent and the visual check, not independent authentication of a human. Never synthesize approval from silence, prior approval of a different job, or the mere availability of a token.
8. A `dispatched` result means the networking library accepted the command. It includes `printerJobName` and `physicalPrintVerified: false`. Read `get_printer_status` and match that job, then inspect the camera before reporting physical printing. Never automatically resend an uncertain dispatch.

Only one review is pending per server session. A new preparation supersedes the previous review. Reviews expire after ten minutes and disappear on restart or cancellation. Confirmation consumes the token before asynchronous work, including when later checks or dispatch fail. The reviewed source file's bytes, previous job identity, nozzle settings, plate identity and selected spool colors/materials must still match. Fresh safety checks run again at the native dispatch boundary.

Camera evidence must come from the same printer, at or after preparation, and be less than two minutes old through dispatch. If the user takes longer to reply, call `camera_snapshot`, inspect the new image and use its new `capture_id`. Camera failure prevents review preparation. A new print review is required if a confirmation attempt is refused.

Preparation retains upstream auto-slicing for unsliced projects. Slice explicitly first when reviewing the generated settings. The native confirmation route uploads its own checked snapshot and dispatches it; it does not start a previously uploaded storage entry by name.

`list_printer_files` reads internal eMMC model storage through Bambu Studio's file service on port 6000 and returns actual printer paths, sizes and timestamps. This includes factory models and uploaded jobs. It does not enumerate external SD/USB storage, timelapses or logs. Internal transfers require the native helper and `libBambuSource` library; upload success requires the printer to advertise internal upload and download support. Cancellation or a connection failure may leave a partial or unverified file; inspect the listing before retrying. Transfers are bounded to 256 MiB and three minutes and are never replayed automatically. `delete_printer_file` retains its restricted FTPS route and cannot delete internal entries.

## Compatibility and trust

### Cloud print route on macOS

Set `BAMBU_NATIVE_PRINT_ROUTE=cloud` and `BAMBU_CLOUD_STUDIO_DIR` to the signed-in Studio data directory, such as `~/Library/Application Support/BambuStudioBeta` (use an absolute path in environment files). The connector reads that profile's encrypted session cache and loads its networking plug-in without launching Studio. It verifies that the configured printer belongs to the account. Native session changes stay in a private temporary directory that is removed when the operation ends; the original Studio session is unchanged.

On macOS, the plug-in also requires Studio's publisher identity before it signs requests. The helper validates the Apple code signatures and Bambu publisher of the Studio executable (`SLICER_PATH`, default `/Applications/BambuStudio.app/Contents/MacOS/BambuStudio`) and the profile's plug-in. A narrowly scoped Security API interposition supplies that installed Studio identity only when the validated plug-in inspects the helper executable. Other signature checks are unchanged. This uses the unmodified plug-in's signing implementation; it does not extract private keys, launch Studio, or disable printer authorization. Missing, modified or differently signed binaries stop the cloud operation before submission. This compatibility mechanism depends on the installed plug-in's behavior and requires revalidation after vendor updates.

The native build places `libbambu-cloud-identity.dylib` beside the helper. Keep these two build artifacts together when using a custom `BAMBU_NATIVE_HELPER` path; the library loads only inside the helper process.

Cloud printing uses the same inspected file snapshot, AMS/nozzle checks, chat approval and fresh printer-state checks as local printing. It calls Bambu's cloud print entry point once. A failed or uncertain submission is never automatically replayed or retried through the local route. `get_connector_info` with `check_connections: true` performs read-only account/device and local file-list checks. Successful authentication does not establish print signing or physical delivery; verify the dispatched job against fresh printer telemetry.

The cloud connection check also requests a protected camera URL and reports `signed_camera_authorization: verified` only for a successful URL response. Camera credentials are discarded. This checks the cloud signing gate independently of account login; it still does not prove print submission or physical delivery.

With the cloud route, pause, resume, stop, heater-off and the other native controls use the same signed cloud session, because the plug-in does not sign local `print.*` commands. The first control to a printer can take a few extra seconds: the plug-in installs its app certificate on the printer, and the helper retries once that is done. Each retry re-runs the fresh-state checks, and none follows a publish that the plug-in accepted. The result reports the printer's own reply (`printer_reply: accepted`). A rejection is an error that includes the printer's reason. A missing reply is reported as unconfirmed; check `get_printer_status` before acting again. A cloud control takes about 10 seconds and needs internet access; when the cloud is unreachable, use the printer screen or Bambu Handy.

`upload_file` remains a local, file-only operation. Cloud print submission can start a physical job and is never used as an upload-only fallback. A failed local connection reports whether the upload began; an unverified file can remain after an interrupted upload. Cloud pairing, Wi-Fi and Handy access do not need to change.

### Recovering a file connection

File-transfer errors include `file_transfer.phase`, `native_stage`, `native_code`, `upload_started`, and `recovery`. `upload_started: false` means no upload request was sent. Once it is true, a partial or unverified file may remain: inspect storage and verify the file before another transfer. Neither result authorizes starting a print.

MQTT status, FTPS login and cloud authentication use different services from internal model storage. If port 6000 closes during connection setup while those other services work, check the printer host and access code. If the failure persists, restart the printer only after its current job has finished and the printer has cooled, then check `list_printer_files` again. A recovered connection does not identify the underlying cause or guarantee it cannot recur. Re-slicing and changing LAN Only or Developer Mode do not repair this connection failure.

After updating the connector, compare `get_connector_info`'s running and disk build IDs. A stale process refuses uploads and print confirmation. The supervisor loads the rebuilt server on the next request once the build has settled. A connector started before the supervisor existed needs one fresh MCP session. Keep any prepared slice and use the same file-only upload tool afterward.

This profile retains upstream's file, temperature, nozzle, AMS and fresh-state checks. It also validates each public tool's input schema and rejects calls to tools outside the profile. Printer resources cannot select a different host.

The native helper relies on Bambu's proprietary networking plug-in. Rebuild after updating the package and revalidate compatibility after Bambu Studio/Connect updates. The macOS path does not pin the vendor library's binary interface. Upstream MQTT certificate verification remains disabled; use a trusted local network. Stdio removes the HTTP endpoint but does not change that printer-network trust assumption.

### Native signing failures

MQTT connection success is separate from device-certificate readiness. A protected command can return `SEND_MSG_FAILED (-4)` while ordinary status queries work. Check that `BAMBU_NATIVE_LAN_ONLY` matches the printer's configured mode and that the plug-in completes its certificate exchange. A successful certificate-install reply and a signed, read-only calibration request establish that protected messaging works; they do not prove that a print was submitted. A calibration reply reporting no matching record is an application-level answer, not a transport or signing error.

`SIGNED_ERROR (-26)` means the networking plug-in rejected print signing. The file may already have uploaded; that does not mean the print command was accepted. Status access, camera access, a successful tunnel probe and upload success do not establish permission to sign print commands.

On macOS, Bambu's plug-in can restrict signing to an authenticated Bambu application. Loading its library into a separately compiled helper does not give that helper Bambu's application identity. Rebuilding the helper or repeatedly submitting the same job does not resolve an application-authorization rejection. Use the official Bambu Studio or Bambu Connect application to submit the reviewed job, or a separately validated native transport. Check printer status and the job name before another submission. A failed `confirm_print` consumes its approval token; a later submission requires a fresh review and approval.

The helper's macOS defaults check Bambu Connect first and then the stable `BambuStudio` data directory. Studio beta installations use a separate `BambuStudioBeta` directory. `BAMBU_NATIVE_PLUGIN` and `BAMBU_NATIVE_CONFIG_DIR` can select another installation explicitly, but changing these paths does not prove its signing authorization or binary compatibility.

Preserve the upstream GPL-2.0 license and contributor attribution. Upstream updates can be merged without replacing the X2D entry point or its tests.
