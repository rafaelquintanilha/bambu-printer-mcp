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

async function server(t, { confirmation = true, printing = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-x2d-profile-"));
  const eventsFile = path.join(dir, "events.jsonl");
  const helper = path.join(dir, "helper.mjs");
  await fs.writeFile(eventsFile, "");
  await fs.writeFile(helper, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const mode = process.argv[2];
appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({mode, model:process.env.BAMBU_MODEL, projectName:process.env.BAMBU_NATIVE_PROJECT_NAME})+'\\n');
if (mode === '--print-authorized') {
  const input = createInterface({input:process.stdin});
  const answer = new Promise(resolve => input.once('line',resolve));
  console.log('native_dispatch_request=1');
  if (await answer !== 'native_dispatch_authorized=1') process.exit(21);
  input.close();
}
console.log(mode === '--upload' ? 'native_upload result=0' : 'native_print result=0');
`, { mode: 0o755 });
  const preload = `
import { appendFileSync } from 'node:fs';
import { BambuImplementation } from ${JSON.stringify(printerModule)};
Object.defineProperty(process,'platform',{value:'darwin'});
const record = event => appendFileSync(${JSON.stringify(eventsFile)},JSON.stringify(event)+'\\n');
BambuImplementation.prototype.getPrinter = async () => { throw new Error('Unexpected real printer connection'); };
BambuImplementation.prototype.disconnectAll = async () => {};
BambuImplementation.prototype.getStatus = async (host, serial) => {
  record({mode:'status',host,serial});
  return {connected:true,status:'RUNNING',model:'x2d',print:{filename:'job',progress:25,timeRemaining:12}};
};
BambuImplementation.prototype.getSafetyStatus = async (_host,serial) => {
  record({mode:'safety'});
  return {connected:true,serial,model:'x2d',status:${JSON.stringify(printing ? "RUNNING" : "IDLE")},
    raw:{serial,model:'x2d',gcode_state:${JSON.stringify(printing ? "RUNNING" : "IDLE")},print_error:0,hms:[],nozzle_diameter:['0.4','0.4'],
      vir_slot:[{id:254,tray_type:'PLA'},{id:255,tray_type:'PLA'}],
      ams:{ams:[{id:'0',tray:[{id:'0',tray_type:'PLA'}]}]}},
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
      BAMBU_REQUIRE_CONFIRMATION: "0", MCP_ALLOW_EXECUTABLE_ARG: "1", BAMBU_NATIVE_HELPER: helper },
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
  zip.file("Metadata/plate_1.json",JSON.stringify({filament_ids:[0]}));
  await fs.writeFile(file, await zip.generateAsync({type:"nodebuffer"}));
  return {client,file,dir,prompts,
    events:async () => (await fs.readFile(eventsFile,"utf8")).trim().split("\n").filter(Boolean).map(JSON.parse),
    call:(name,args={}) => client.callTool({name,arguments:args})};
}

test("X2D stdio entry advertises the complete local workflow without credential or route overrides", async t => {
  const s = await server(t);
  assert.equal(s.client.getServerVersion().name,"bambu-x2d-mcp");
  const {tools} = await s.client.listTools();
  for (const name of ["get_printer_status","get_printer_filaments","camera_snapshot","slice_stl","get_slice_settings","inspect_print_file","upload_file","print_3mf","pause_print","cancel_print","x2d_native_control","scale_stl","blender_mcp_call"]) {
    assert(tools.some(tool=>tool.name===name),name);
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
    ["inspect_print_file",{file_path:s.file,bambu_model:"a1"}],
    ["slice_stl",{stl_path:sampleStl,slicer_path:"/bin/echo"}],
    ["scale_stl",{stl_path:sampleStl,scale_x:"2"}],
    ["print_3mf",{three_mf_path:s.file,use_ams:"false"}],
  ]) await assert.rejects(s.call(name,args), /Invalid.*arguments|not available/);
  await assert.rejects(s.client.readResource({uri:"printer://203.0.113.1/status"}),/configured printer/);
  assert.deepEqual(await s.events(),[]);
});

test("X2D status retains progress and remaining time with the configured printer", async t => {
  const s = await server(t);
  const result = await s.call("get_printer_status");
  assert.equal(result.structuredContent.print.progress,25);
  assert.equal(result.structuredContent.print.timeRemaining,12);
  assert.deepEqual(await s.events(),[{mode:"status",host:"127.0.0.1",serial:"20PTEST"}]);
});

test("X2D local model and sliced-file inspection need no printer connection or model argument", async t => {
  const s = await server(t);
  const model = await s.call("get_stl_info",{stl_path:sampleStl});
  assert.notEqual(model.isError,true);
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
  assert.deepEqual((await s.events()).filter(e=>e.mode.startsWith("--")).map(e=>e.mode),["--upload"]);
  assert.equal(s.prompts.length,0);
});

test("X2D keeps human confirmation even when inherited configuration disables it", async t => {
  const s = await server(t,{confirmation:false});
  const result = await s.call("print_3mf",{three_mf_path:s.file,ams_slots:[0]});
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/declined/i);
  assert.equal(s.prompts.length,1);
  assert.equal((await s.events()).some(e=>e.mode.startsWith("--")),false);
});

test("X2D print returns a dispatch receipt with the exact job name, without claiming physical printing", async t => {
  const s = await server(t);
  const result = await s.call("print_3mf",{three_mf_path:s.file,ams_slots:[0]});
  assert.notEqual(result.isError,true,JSON.stringify(result));
  assert.equal(result.structuredContent.status,"dispatched");
  assert.equal(result.structuredContent.physicalPrintVerified,false);
  const sent = (await s.events()).filter(e=>e.mode==="--print-authorized");
  assert.equal(sent.length,1);
  assert.equal(sent[0].model,"x2d");
  assert.equal(result.structuredContent.printerJobName,sent[0].projectName);
  assert.equal(result.structuredContent.remoteProjectPath,`${sent[0].projectName}.3mf`);
  assert.equal(s.prompts.length,1);
});

test("X2D print still refuses a busy printer before dispatch", async t => {
  const s = await server(t,{printing:true});
  const result = await s.call("print_3mf",{three_mf_path:s.file,ams_slots:[0]});
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/RUNNING|idle/);
  assert.equal((await s.events()).some(e=>e.mode.startsWith("--")),false);
});
