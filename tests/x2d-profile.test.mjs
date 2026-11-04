import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const entry = fileURLToPath(new URL("../dist/x2d.js", import.meta.url));
const printerModule = new URL("../dist/printers/bambu.js", import.meta.url).href;
const sampleStl = fileURLToPath(new URL("../test/sample_cube.stl", import.meta.url));
const fileServiceFixture = new URL("./fixtures/file-service.mjs", import.meta.url).href;

async function server(t, { confirmation = true, printing = false, raw = {}, cameraError = false, changeAtDispatch = {}, printResult = 0, fileService = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-x2d-profile-"));
  const eventsFile = path.join(dir, "events.jsonl");
  const helper = path.join(dir, "helper.mjs");
  const stateFile = path.join(dir, "state.json");
  await fs.writeFile(stateFile, JSON.stringify(raw));
  await fs.writeFile(eventsFile, "");
  await fs.writeFile(helper, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { runFakeFileService } from ${JSON.stringify(fileServiceFixture)};
const mode = process.argv[2];
appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({mode, model:process.env.BAMBU_MODEL, projectName:process.env.BAMBU_NATIVE_PROJECT_NAME})+'\\n');
if (mode === '--file-service') { await runFakeFileService({eventsFile:${JSON.stringify(eventsFile)},...${JSON.stringify(fileService)}}); process.exit(0); }
if (mode === '--print-authorized') {
  const input = createInterface({input:process.stdin});
  const answer = new Promise(resolve => input.once('line',resolve));
  console.log('native_dispatch_request=1');
  if (await answer !== 'native_dispatch_authorized=1') process.exit(21);
  appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({mode:'dispatched'})+'\\n');
  input.close();
}
console.log(mode === '--upload' ? 'native_upload result=0' : 'native_print result=${printResult}');
process.exit(mode === '--upload' || ${printResult} === 0 ? 0 : 20);
`, { mode: 0o755 });
  const preload = `
import { appendFileSync, readFileSync } from 'node:fs';
import { BambuImplementation } from ${JSON.stringify(printerModule)};
Object.defineProperty(process,'platform',{value:'darwin'});
const record = event => appendFileSync(${JSON.stringify(eventsFile)},JSON.stringify(event)+'\\n');
BambuImplementation.prototype.getPrinter = async () => { throw new Error('Unexpected real printer connection'); };
BambuImplementation.prototype.disconnectAll = async () => {};
BambuImplementation.prototype.cameraSnapshot = async () => {
  record({mode:'camera'});
  if (${cameraError}) throw new Error('Camera unavailable');
  return {status:'success',format:'image/jpeg',base64:'/9j/2Q==',sizeBytes:4,transport:'rtsps-322'};
};
BambuImplementation.prototype.getStatus = async (host, serial) => {
  record({mode:'status',host,serial});
  return {connected:true,serial,status:'RUNNING',model:'x2d',print:{filename:'job',progress:25,timeRemaining:12},
    observation:{receivedAt:Date.now(),requestedAt:Date.now()-1},raw:{task_id:'cloud-job-1',subtask_id:'cloud-job-1',print_error:0,hms:[],modules:Array(500).fill({name:'ota'})}};
};
let safetyReads = 0;
BambuImplementation.prototype.getSafetyStatus = async (_host,serial) => {
  safetyReads++;
  record({mode:'safety'});
  return {connected:true,serial,model:'x2d',status:${JSON.stringify(printing ? "RUNNING" : "IDLE")},
    raw:{serial,model:'x2d',gcode_state:${JSON.stringify(printing ? "RUNNING" : "IDLE")},print_error:0,hms:[],nozzle_diameter:['0.4','0.4'],
      vir_slot:[{id:254,tray_type:'PLA'},{id:255,tray_type:'PLA'}],
      ams:{ams:[{id:'0',tray:[{id:'0',tray_type:'PLA',tray_color:'161616FF'}]}]},
      ...JSON.parse(readFileSync(${JSON.stringify(stateFile)},'utf8')),
      ...(safetyReads >= 5 ? ${JSON.stringify(changeAtDispatch)} : {})},
    observation:{source:'mqtt',requestedAt:Date.now()-1,receivedAt:Date.now(),identitySource:'report'}};
};
`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, entry],
    cwd: dir,
    // Contradictory inherited settings must not weaken the dedicated entry point.
    env: { PATH: process.env.PATH, HOME: dir, MCP_TRANSPORT: "streamable-http",
      BAMBU_MODEL: "a1", BAMBU_PRINTER_MODEL: "p1s", SLICER_TYPE: "orca-slicer-api",
      PRINTER_HOST: "127.0.0.1", BAMBU_SERIAL: "20PTEST", BAMBU_TOKEN: "DUMMY",
      BAMBU_REQUIRE_CONFIRMATION: "0", MCP_ALLOW_EXECUTABLE_ARG: "1", BAMBU_NATIVE_HELPER: helper, BAMBU_LIBRARY_DIRS: dir },
    stderr: "pipe",
  });
  const client = new Client({name:"x2d-profile-tests",version:"0"}, {capabilities:{elicitation:{form:{}}}});
  const prompts = [];
  client.setRequestHandler(ElicitRequestSchema, async request => {
    prompts.push(request.params.message);
    return confirmation ? {action:"accept",content:{confirmed:true}} : {action:"decline"};
  });
  t.after(async () => { await client.close(); await fs.rm(dir,{recursive:true,force:true}); });
  await client.connect(transport);
  const file = path.join(dir,"badge.3mf");
  const zip = new JSZip();
  zip.file("3D/3dmodel.model", '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources/><build/></model>');
  zip.file("Metadata/plate_1.gcode", '; printer_model = Bambu Lab X2D\n; nozzle_diameter = 0.4;0.4\n; filament_type = PLA\n; filament_map = 1\n; physical_extruder_map = 1,0\n; curr_bed_type = Textured PEI Plate\n; filament_colour = #FFFFFF\nG1 X0 Y0\n');
  zip.file("Metadata/plate_1.json",JSON.stringify({filament_ids:[0],bbox_objects:[{id:1,name:'badge',area:100}]}));
  zip.file("Metadata/plate_1.png",Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=','base64'));
  await fs.writeFile(file, await zip.generateAsync({type:"nodebuffer"}));
  return {client,file,dir,prompts,
    setState: state => fs.writeFile(stateFile, JSON.stringify(state)),
    events:async () => (await fs.readFile(eventsFile,"utf8")).trim().split("\n").filter(Boolean).map(JSON.parse),
    call:(name,args={}) => client.callTool({name,arguments:args})};
}

test("X2D stdio entry advertises the complete local workflow without credential or route overrides", async t => {
  const s = await server(t);
  assert.equal(s.client.getServerVersion().name,"bambu-x2d-mcp");
  const {tools} = await s.client.listTools();
  for (const name of ["get_connector_info","get_print_history","get_printer_status","get_printer_filaments","camera_snapshot","slice_stl","get_slice_settings","inspect_print_file","upload_file","prepare_print","confirm_print","pause_print","cancel_print","x2d_native_control","get_saved_print_details"]) {
    assert(tools.some(tool=>tool.name===name),name);
  }
  // One tool per job: duplicates and workflows covered by other tools stay in the generic server only.
  for (const name of ["print_3mf","slice_with_template","list_templates","save_template","scale_stl","rotate_stl","lay_flat","center_model","get_stl_info","extend_stl_base","merge_vertices","blender_mcp_status","blender_mcp_call","blender_mcp_edit_model"]) {
    assert.equal(tools.some(tool=>tool.name===name),false,name);
  }
  for (const tool of tools) for (const field of ["template_name","template_dir","filament_profile"]) {
    assert.equal(Object.hasOwn(tool.inputSchema.properties,field),false,`${tool.name}.${field}`);
  }
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties,false);
    for (const field of ["host","bambu_token","bambu_serial","bambu_model","connection_mode","slicer_path","bridge_command","print"]) {
      assert.equal(Object.hasOwn(tool.inputSchema.properties,field),false,`${tool.name}.${field}`);
    }
  }
  assert.equal(tools.some(tool=>tool.name==="print_collar_charm"),false);
  assert.equal(tools.some(tool=>tool.name==="start_print"),false);
  assert.deepEqual(await s.events(),[]);
});

test("X2D rejects hidden tools, credentials, wrong models and invalid types before printer access", async t => {
  const s = await server(t);
  for (const [name,args] of [
    ["bambu_network_call",{method:"net.start_print"}],
    ["start_print",{filename:"test.gcode"}],
    ["upload_file",{file_path:s.file,filename:"badge.3mf",print:true}],
    ["get_printer_status",{host:"203.0.113.1"}],
    ["get_printer_status",{bambu_token:"override"}],
    ["get_printer_status",{include_raw:"true"}],
    ["get_print_history",{limit:51}],
    ["inspect_print_file",{file_path:s.file,bambu_model:"a1"}],
    ["slice_stl",{stl_path:sampleStl,slicer_path:"/bin/echo"}],
    ["scale_stl",{stl_path:sampleStl,scale_x:"2"}],
    ["print_3mf",{three_mf_path:s.file,ams_slots:[0]}],
    ["prepare_print",{three_mf_path:s.file,use_ams:"false"}],
    ["slice_stl",{stl_path:sampleStl,template_name:"saved"}],
  ]) await assert.rejects(s.call(name,args), /Invalid.*arguments|not available/);
  await assert.rejects(s.client.readResource({uri:"printer://203.0.113.1/status"}),/configured printer/);
  assert.deepEqual(await s.events(),[]);
});

test("X2D status retains progress and remaining time with the configured printer", async t => {
  const s = await server(t);
  const result = await s.call("get_printer_status");
  assert.equal(result.structuredContent.print.progress,25);
  assert.equal(result.structuredContent.print.timeRemaining,12);
  assert.equal(result.structuredContent.print.task_id,'cloud-job-1');
  assert.equal(result.structuredContent.raw,undefined);
  assert.equal(result.structuredContent.observation.stale,false);
  assert.equal(result.structuredContent.tracking.recorded,true);
  const history = await s.call('get_print_history');
  assert.equal(history.structuredContent.jobs.length,1);
  assert.equal(history.structuredContent.live_status,false);
  assert.equal(history.structuredContent.jobs[0].latest.print.task_id,'cloud-job-1');
  assert.deepEqual(await s.events(),[{mode:"status",host:"127.0.0.1",serial:"20PTEST"}]);
});

test('X2D diagnostics describe the running build and tools without contacting hardware',async t=>{
  const s=await server(t);
  const result=await s.call('get_connector_info');
  const data=result.structuredContent;
  assert.match(data.build_id,/^[a-f0-9]{16}$/);
  assert.equal(data.disk_build_id,data.build_id);
  assert.equal(data.restart_required,false);
  assert.equal(data.features.camera_image_content,true);
  assert(data.tool_names.includes('get_print_history'));
  assert.equal(data.native_transport.signing,'not_checked');
  assert.equal(data.native_transport.local_prerequisites_available,true);
  assert.deepEqual(await s.events(),[]);
});

for (const started of [false, true]) test(`X2D transfer failures preserve upload state through MCP: started=${started}`, async t => {
  const s = await server(t, { fileService: started ? { uploadDisconnect: true } : { connectionFailure: true } });
  const result = await s.call('upload_file', { file_path: s.file, filename: 'saved-spacers.3mf' });
  assert.equal(result.isError, true);
  const error = result.structuredContent;
  assert.equal(error.retryable, false);
  assert.equal(error.file_transfer.route, 'local-file-service');
  assert.equal(error.file_transfer.upload_started, started);
  assert.equal(error.file_transfer.print_requested, false);
  assert.equal(error.file_transfer.phase, started ? 'upload' : 'connection');
  assert.equal(error.file_transfer.native_stage, started ? null : 'open');
  assert.equal(error.file_transfer.native_code, started ? null : -1001);
  assert.equal(error.suggestion, error.file_transfer.recovery);
  assert.match(error.suggestion, started ? /verify any existing file/ : /finished and it has cooled/);
  const events = await s.events();
  assert.equal(events.filter(event => event.mode === '--file-service').length, 1);
  assert.equal(events.some(event => /print|dispatch/.test(event.mode)), false);
  assert.equal(events.filter(event => event.command === 5).length, started ? 1 : 0);
});

test('X2D raw status is explicit and the status resource stays compact',async t=>{
  const s=await server(t);
  const raw=await s.call('get_printer_status',{include_raw:true});
  assert.equal(raw.structuredContent.raw.modules.length,500);
  const resource=await s.client.readResource({uri:'printer://127.0.0.1/status'});
  const data=JSON.parse(resource.contents[0].text);
  assert.equal(data.raw,undefined);
  assert.equal(data.print.task_id,'cloud-job-1');
});

test("X2D local model and sliced-file inspection need no printer connection or model argument", async t => {
  const s = await server(t);
  const model = await s.call("get_saved_print_details",{file_path:sampleStl});
  assert.notEqual(model.isError,true,JSON.stringify(model));
  const slice = await s.call("inspect_print_file",{file_path:s.file});
  assert.notEqual(slice.isError,true,JSON.stringify(slice));
  assert.equal(slice.structuredContent.inspection.model,"x2d");
  assert.equal(slice.structuredContent.dispatch_authorized,false);
  assert.deepEqual(await s.events(),[]);
});

test("X2D upload selects native transport and never starts a print, including while another job runs", async t => {
  const s = await server(t,{printing:true});
  const result = await s.call("upload_file",{file_path:s.file,filename:"badge.3mf"});
  assert.notEqual(result.isError,true,JSON.stringify(result));
  assert.equal(result.structuredContent.uploaded,true);
  assert.equal(result.structuredContent.printRequested,false);
  assert.match(result.structuredContent.remotePath,/checked-.*badge\.3mf$/);
  assert.deepEqual((await s.events()).filter(e=>e.mode.startsWith("--")).map(e=>e.mode),["--file-service"]);
  assert.equal(result.structuredContent.downloadVerified,true);
  assert.equal(result.structuredContent.storage,"internal");
  assert.equal(s.prompts.length,0);
});

test("X2D files resource uses the same internal listing as the tool", async t => {
  const s = await server(t);
  const result = await s.client.readResource({uri:'printer://127.0.0.1/files'});
  const data = JSON.parse(result.contents[0].text);
  assert.equal(data.storage,'internal');
  assert.deepEqual(data.files,[]);
  assert.deepEqual((await s.events()).filter(event=>event.mode.startsWith('--')).map(event=>event.mode),['--file-service']);
});

test("X2D saved library persists observed collections and finds existing files without printer or slicer access", async t => {
  const s = await server(t);
  for(const name of ['find_saved_prints','get_saved_print_details','save_makerworld_collection']) assert((await s.client.listTools()).tools.some(tool=>tool.name===name));
  const saved=await s.call('save_makerworld_collection',{collection_url:'https://makerworld.com/en/collections/123',title:'Observed',expected_model_count:1,models:[{url:'https://makerworld.com/en/models/456',title:'Badge'}]});
  assert.equal(saved.structuredContent.model_count,1);
  const found=await s.call('find_saved_prints',{query:'badge'});
  assert.equal(found.structuredContent.matching_files,1);
  assert.equal(found.structuredContent.matching_models,1);
  assert.equal(found.structuredContent.files[0].kind,'prepared_3mf');
  const detail=await s.call('get_saved_print_details',{file_path:s.file});
  assert.equal(detail.structuredContent.dispatch_authorized,false);
  assert.equal(detail.structuredContent.printer_storage.checked,false);
  assert.equal(detail.content[1].type,'image');
  assert.equal(detail.content[1].mimeType,'image/png');
  assert.equal(detail.structuredContent.preview.base64,undefined);
  assert.deepEqual(await s.events(),[]);
  await assert.rejects(s.call('find_saved_prints',{query:'badge',host:'203.0.113.1'}),/Invalid.*arguments/);
});

test("X2D prepare_print only prepares a review even when inherited configuration disables confirmation", async t => {
  const s = await server(t,{confirmation:false});
  const result = await s.call("prepare_print",{three_mf_path:s.file,ams_slots:[0]});
  assert.notEqual(result.isError,true,JSON.stringify(result));
  assert.equal(result.structuredContent.status,'awaiting_confirmation');
  assert.equal(result.structuredContent.printRequested,false);
  assert.equal(result.structuredContent.summary.object_count,1);
  assert.equal(result.structuredContent.summary.filaments[0].color,'161616FF');
  assert(result.content.some(item=>item.type==='image'));
  assert.equal(result.structuredContent.camera.base64,undefined);
  assert.equal(s.prompts.length,0);
  assert.equal((await s.events()).some(e=>e.mode.startsWith("--")),false);
});

function confirmationArgs(prepared) {
  return {approval_id:prepared.approval_id,user_approved:true,user_approval:'Yes, print that one black badge.',
    camera_capture_id:prepared.camera.capture_id,plate_clear:true};
}

test('X2D signing rejection preserves recovery guidance and consumes approval without retry', async t => {
  const s=await server(t,{printResult:-26});
  const prepared=await s.call('prepare_print',{three_mf_path:s.file,ams_slots:[0]});
  const args=confirmationArgs(prepared.structuredContent);
  const result=await s.call('confirm_print',args);
  assert.equal(result.isError,true);
  assert.equal(result.structuredContent.retryable,false);
  assert.match(result.structuredContent.message,/SIGNED_ERROR \(-26\)/);
  assert.equal(result.structuredContent.suggestion,result.structuredContent.message);
  assert.doesNotMatch(result.structuredContent.suggestion,/Check parameters and try again/);
  const reused=await s.call('confirm_print',args);
  assert.equal(reused.isError,true);
  assert.equal((await s.events()).filter(e=>e.mode==='dispatched').length,1);
});

test("X2D chat approval dispatches the reviewed finished-bed job without client elicitation", async t => {
  const s = await server(t,{confirmation:false,raw:{gcode_state:'FINISH',subtask_name:'previous',job_id:'old'}});
  const prepared = await s.call("prepare_print",{three_mf_path:s.file,ams_slots:[0]});
  assert.notEqual(prepared.isError,true,JSON.stringify(prepared));
  const result = await s.call('confirm_print',confirmationArgs(prepared.structuredContent));
  assert.notEqual(result.isError,true,JSON.stringify(result));
  assert.equal(result.structuredContent.status,"dispatched");
  assert.equal(result.structuredContent.physicalPrintVerified,false);
  const sent = (await s.events()).filter(e=>e.mode==="--print-authorized");
  assert.equal(sent.length,1);
  assert.equal(sent[0].model,"x2d");
  assert.equal(result.structuredContent.printerJobName,sent[0].projectName);
  assert.equal(result.structuredContent.remoteProjectPath,`${sent[0].projectName}.3mf`);
  assert.equal(s.prompts.length,0);
  assert.equal(result.structuredContent.approval_source,'chat');
  assert.equal((await s.events()).filter(e=>e.mode==='dispatched').length,1);
  const reused=await s.call('confirm_print',confirmationArgs(prepared.structuredContent));
  assert.equal(reused.isError,true);
  assert.match(reused.content[0].text,/already used/);
});

test("X2D confirmation rejects missing human approval, missing visual clearance and print overrides", async t => {
  const s=await server(t);
  const prepared=(await s.call('prepare_print',{three_mf_path:s.file,ams_slots:[0]})).structuredContent;
  for(const extra of [{user_approved:false},{plate_clear:false},{ams_slots:[1]},{three_mf_path:'/tmp/other.3mf'},{user_approval:''}]) {
    await assert.rejects(s.call('confirm_print',{...confirmationArgs(prepared),...extra}),/Invalid.*arguments/);
  }
  assert.equal((await s.events()).some(e=>e.mode.startsWith('--')),false);
});

test("X2D new review supersedes the previous job and failed camera capture creates no usable approval", async t => {
  const s=await server(t);
  const old=(await s.call('prepare_print',{three_mf_path:s.file,ams_slots:[0]})).structuredContent;
  await s.call('prepare_print',{three_mf_path:s.file,ams_slots:[0]});
  const obsolete=await s.call('confirm_print',confirmationArgs(old));
  assert.equal(obsolete.isError,true);
  assert.equal((await s.events()).some(e=>e.mode.startsWith('--')),false);
  const failed=await server(t,{cameraError:true});
  const result=await failed.call('prepare_print',{three_mf_path:failed.file,ams_slots:[0]});
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/Camera unavailable/);
  assert.equal(result.structuredContent.approval_id,undefined);
  assert.equal((await failed.events()).some(e=>e.mode.startsWith('--')),false);
});

test("X2D changed source file invalidates approval before starting the native helper", async t => {
  const s=await server(t);
  const prepared=(await s.call('prepare_print',{three_mf_path:s.file,ams_slots:[0]})).structuredContent;
  const zip=await JSZip.loadAsync(await fs.readFile(s.file));
  zip.file('Metadata/plate_1.gcode',(await zip.file('Metadata/plate_1.gcode').async('string'))+'; changed\n');
  await fs.writeFile(s.file,await zip.generateAsync({type:'nodebuffer'}));
  const result=await s.call('confirm_print',confirmationArgs(prepared));
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/file, plate or printer changed/);
  assert.equal((await s.events()).some(e=>e.mode.startsWith('--')),false);
});

for(const [name,change] of [
  ['job',{gcode_state:'FINISH',subtask_name:'new-job',job_id:'new'}],
  ['color',{ams:{ams:[{id:'0',tray:[{id:'0',tray_type:'PLA',tray_color:'FFFFFFFF'}]}]}}],
  ['nozzle',{nozzle_diameter:['0.6','0.4']}],
  ['material',{ams:{ams:[{id:'0',tray:[{id:'0',tray_type:'ABS',tray_color:'161616FF'}]}]}}],
  ['error',{print_error:123}],
  ['busy',{gcode_state:'RUNNING'}],
]) test(`X2D rejects changed ${name} after review`,async t=>{
  const s=await server(t);
  const prepared=(await s.call('prepare_print',{three_mf_path:s.file,ams_slots:[0]})).structuredContent;
  await s.setState(change);
  const result=await s.call('confirm_print',confirmationArgs(prepared));
  assert.equal(result.isError,true,JSON.stringify(result));
  assert.equal((await s.events()).some(e=>e.mode.startsWith('--')),false);
});

test("X2D rechecks spool color at the native dispatch boundary",async t=>{
  const s=await server(t,{changeAtDispatch:{ams:{ams:[{id:'0',tray:[{id:'0',tray_type:'PLA',tray_color:'FFFFFFFF'}]}]}}});
  const prepared=(await s.call('prepare_print',{three_mf_path:s.file,ams_slots:[0]})).structuredContent;
  const result=await s.call('confirm_print',confirmationArgs(prepared));
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/color changed/);
  assert.equal((await s.events()).filter(e=>e.mode==='--print-authorized').length,1);
  assert.equal((await s.events()).some(e=>e.mode==='dispatched'),false);
});

test("X2D concurrent confirms can dispatch a reviewed job only once",async t=>{
  const s=await server(t);
  const prepared=(await s.call('prepare_print',{three_mf_path:s.file,ams_slots:[0]})).structuredContent;
  const results=await Promise.all([s.call('confirm_print',confirmationArgs(prepared)),s.call('confirm_print',confirmationArgs(prepared))]);
  assert.equal(results.filter(r=>r.isError!==true).length,1);
  assert.equal((await s.events()).filter(e=>e.mode==='dispatched').length,1);
});

test("X2D print still refuses a busy printer before dispatch", async t => {
  const s = await server(t,{printing:true});
  const result = await s.call("prepare_print",{three_mf_path:s.file,ams_slots:[0]});
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/RUNNING|idle/);
  assert.equal((await s.events()).some(e=>e.mode.startsWith("--")),false);
});
