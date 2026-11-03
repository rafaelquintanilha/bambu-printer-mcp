import assert from 'node:assert/strict';
import {createCipheriv} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import JSZip from 'jszip';
import {decodeStudioSession, verifyCloudPrinter, withStudioCloudSession, cloudPrintMetadata} from '../dist/bambu-cloud.js';
import {printWithBambuNative, probeBambuCloud} from '../dist/bambu-native.js';

const secret = 'PRIVATE_TEST_SESSION_1234567890';
const hostPlatform = process.platform;
async function setup(t, device = {dev_id:'20PTEST',online:true}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'cloud-test-'));
  const user={token:secret,user_id:'123',refresh_token:'PRIVATE_REFRESH',login_status:1};
  const cipher=createCipheriv('aes-128-ecb',Buffer.from('i4crL3LESLnWapLS'),null);
  const encoded=Buffer.concat([cipher.update(JSON.stringify({user,country_code:'Others'})),cipher.final()]);
  await fs.writeFile(path.join(directory,'BambuNetworkEngine.conf'),encoded);
  await fs.writeFile(path.join(directory,'BambuStudio.conf'),JSON.stringify({app:{version:'02.08.04.61',slicer_uuid:'test-client'}}));
  const oldFetch=globalThis.fetch, oldEnv={...process.env}, platform=Object.getOwnPropertyDescriptor(process,'platform');
  const requests=[];
  globalThis.fetch=async (url,options)=>{requests.push({url,options});return new Response(JSON.stringify({devices:[device],message:'success',code:null,error:null}));};
  process.env.BAMBU_CLOUD_STUDIO_DIR=directory;
  Object.defineProperty(process,'platform',{value:'darwin'});
  t.after(async()=>{globalThis.fetch=oldFetch;Object.defineProperty(process,'platform',platform);for(const key of ['BAMBU_CLOUD_STUDIO_DIR','BAMBU_NATIVE_PRINT_ROUTE','BAMBU_NATIVE_HELPER']){if(oldEnv[key]===undefined)delete process.env[key];else process.env[key]=oldEnv[key];}await fs.rm(directory,{recursive:true,force:true});});
  return {directory,encoded,requests};
}

test('cloud health reads only the configured account and exposes no token',async t=>{
  const s=await setup(t);
  assert.equal(decodeStudioSession(s.encoded).user.token,secret);
  const result=await verifyCloudPrinter('20PTEST');
  assert.equal(result.printer_matched,true);
  assert.equal(result.online,true);
  assert.equal(result.submission,'not_checked');
  assert(!JSON.stringify(result).includes(secret));
  assert.equal(s.requests.length,1);
  assert.equal(s.requests[0].options.method,'GET');
  assert.equal(s.requests[0].options.headers.Authorization,'Bearer '+secret);
  assert.equal(s.requests[0].options.headers['X-BBL-Client-Name'],'BambuStudio');
});

test('wrong account and expired login prevent native dispatch',async t=>{
  await setup(t,{dev_id:'DIFFERENT',online:true});
  let launched=false;
  await assert.rejects(withStudioCloudSession('20PTEST',undefined,async()=>{launched=true;}),/not bound/);
  assert.equal(launched,false);
  globalThis.fetch=async()=>new Response('',{status:401});
  await assert.rejects(withStudioCloudSession('20PTEST',undefined,async()=>{launched=true;}),/HTTP 401/);
  assert.equal(launched,false);
});

test('disposable native cloud configuration is private and removed after failure',async t=>{
  const s=await setup(t);let copied;
  await assert.rejects(withStudioCloudSession('20PTEST',undefined,async env=>{
    copied=env.BAMBU_NATIVE_CONFIG_DIR;
    assert.equal((await fs.stat(copied)).mode&0o777,0o700);
    // The plug-in reads its own session file; no plain token copy is handed over.
    assert.deepEqual(await fs.readdir(copied),['BambuNetworkEngine.conf']);
    assert.equal((await fs.stat(path.join(copied,'BambuNetworkEngine.conf'))).mode&0o777,0o600);
    assert.equal(env.BAMBU_NATIVE_STUDIO_VERSION,'02.08.04.61');
    assert(!JSON.stringify(env).includes(secret));
    throw new Error('synthetic failure');
  }),/synthetic failure/);
  await assert.rejects(fs.stat(copied),{code:'ENOENT'});
  assert.deepEqual(await fs.readFile(path.join(s.directory,'BambuNetworkEngine.conf')),s.encoded);
});

for(const rejected of [false,true]) test('cloud print uses one guarded cloud call, no local fallback: '+rejected,async t=>{
  const s=await setup(t);
  const helper=path.join(s.directory,'helper.mjs');
  const events=path.join(s.directory,'events.jsonl');
  await fs.writeFile(helper,`#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
appendFileSync(${JSON.stringify(events)},JSON.stringify({mode:process.argv[2]})+'\\n');
if(process.argv[2]!=='--cloud-print-authorized')process.exit(2);
console.log('private vendor noise ${secret}');
console.error('private diagnostic ${secret}');
const reader=createInterface({input:process.stdin})[Symbol.asyncIterator]();
for(const attempt of [1,2]){console.log('native_dispatch_request='+attempt);if((await reader.next()).value!=='native_dispatch_authorized='+attempt)process.exit(3);}
console.log('native_print result=${rejected?-26:0}');
process.exit(${rejected?20:0});
`,{mode:0o755});
  process.env.BAMBU_NATIVE_HELPER=helper;process.env.BAMBU_NATIVE_PRINT_ROUTE='cloud';
  let checks=0;const updates=[];
  const promise=printWithBambuNative({host:'127.0.0.1',serial:'20PTEST',token:'DUMMY',filePath:'/tmp/checked.3mf',projectName:'test',presetName:'test',plateIndex:0,bedType:'textured_plate',useAMS:true},line=>updates.push(line),{beforeDispatch:async()=>{checks++;}});
  if(rejected)await assert.rejects(promise,/uncertain.*do not automatically resend/);
  else assert.equal((await promise).route,'bambu-cloud');
  assert.equal(checks,2);
  assert(!updates.join('').includes(secret));
  assert.equal((await fs.readFile(events,'utf8')).trim().split('\n').length,1);
});

test('cloud mappings retain the checked left nozzle and gray AMS slot',async t=>{
  const s=await setup(t), file=path.join(s.directory,'part.3mf'), zip=new JSZip();
  zip.file('Metadata/project_settings.config',JSON.stringify({filament_colour:['#898989'],filament_ids:['GFL99']}));
  zip.file('Metadata/plate_1.gcode','; physical_extruder_map = 1,0\n');
  await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));
  const metadata=await cloudPrintMetadata(file,{nozzleDiameters:[0.4,0.4],filamentNozzleIndices:[1],materials:['PLA'],plateInternalPath:'Metadata/plate_1.gcode'},
    {nozzles:[{index:0,diameter:0.4,flow:'standard'},{index:1,diameter:0.4,flow:'standard'}],filaments:[{filamentPosition:0,slot:2,color:'898989FF',profile:'GFL99'}]});
  assert.deepEqual(JSON.parse(metadata.nozzleMapping),[1,0]);
  assert.deepEqual(JSON.parse(metadata.nozzlesInfo).map(n=>n.id),[1,0]);
  assert.deepEqual(JSON.parse(metadata.amsMappingInfo),[{ams:2,filamentId:'GFL99',filamentType:'PLA',nozzleId:1,sourceColor:'#898989FF',targetColor:'898989FF'}]);
});

test('compiled cloud operation gates both entry and sending and never calls the LAN printer',async t=>{
  const s=await setup(t), source=fileURLToPath(new URL('../native/bambu-native-print.cpp',import.meta.url));
  const driver=path.join(s.directory,'driver.cpp'), binary=path.join(s.directory,'native');
  await fs.writeFile(driver,`
#define main unused_native_main
#include ${JSON.stringify(source)}
#undef main
std::function<void(int,int)> cloudConnected;
std::function<void(std::string,std::string)> cloudMessage;
std::function<void(std::string)> printerConnected;
std::string selected;
bool subscribed=false, active=false, capabilityDelivered=false, appCertUpdated=false;
bool configured=false, logInitialized=false, certificatesSet=false, headersSet=false;
extern "C" bool bambu_network_is_user_login(void*) { return true; }
extern "C" std::string bambu_network_get_version() { return "02.08.04.60"; }
// Studio's extra headers are client identity only. The plug-in adds them to
// presigned storage uploads too, so credentials here break the job upload.
extern "C" int bambu_network_set_extra_http_header(void*, std::map<std::string,std::string> headers) {
  if(!certificatesSet || headers.count("Authorization") || headers.count("Accept") || headers.count("User-Agent")) return -1;
  for(const auto& header : headers) if(header.first.rfind("X-BBL-",0)!=0 || header.second.find("${secret}")!=std::string::npos) return -1;
  headersSet=headers["X-BBL-Client-Name"]=="BambuStudio" && headers["X-BBL-Client-Version"]=="02.08.04.61" && headers["X-BBL-Device-ID"]=="test-client";
  return headersSet ? 0 : -1;
}
extern "C" int bambu_network_set_on_server_connected_fn(void*,std::function<void(int,int)> fn) { cloudConnected=fn; return 0; }
extern "C" int bambu_network_connect_server(void*) { cloudConnected(0,0); return 0; }
extern "C" int bambu_network_set_user_selected_machine(void*,std::string serial) { selected=serial; return 0; }
extern "C" int bambu_network_add_subscribe(void*,std::vector<std::string> serials) { subscribed=serials==std::vector<std::string>{selected}; return subscribed?0:-1; }
extern "C" int bambu_network_start_subscribe(void*,std::string module) { active=module=="app"; if(active)printerConnected(selected); return active?0:-1; }
extern "C" int bambu_network_send_message(void*,std::string serial,std::string message,int,int) {
  if(serial!=selected || !subscribed || !active || !appCertUpdated || message.find("pushall")==std::string::npos) return -1;
  cloudMessage("OTHER",R"({"print":{"fun":"1234"}})");
  cloudMessage(serial,R"({"print":{"gcode_state":"FINISH"}})");
  if(envOr("TEST_CLOUD_MISSING_FLAGS")=="1") return 0;
  capabilityDelivered=true;
  cloudMessage(serial,R"({"print":{"fun":"1234"}})");
  return 0;
}
extern "C" int bambu_network_start_print(void*,BBL::PrintParams p,BBL::OnUpdateStatusFn update,BBL::WasCancelledFn,std::function<bool(int,std::string)> wait) {
  if(!capabilityDelivered) return -3140;
  if(p.connection_type!="cloud" || p.task_bed_type!="textured_plate" || p.plate_index!=1 || p.ams_mapping!="[2]" || p.nozzle_mapping!="[1,0]") return -99;
  if(envOr("TEST_CLOUD_UPLOAD_FAIL")=="1") {
    update(1,-3030,"upload_3mf_config failed(-1),code=400,body=<Error><Code>InvalidArgument</Code><Message>PRIVATE_SIGNED_URL</Message></Error>");
    return -3030;
  }
  update(1,100,"upload complete");
  update(3,0,"sending");
  std::ofstream receipt(envOr("TEST_CLOUD_RECEIPT")); receipt<<"submitted";receipt.close();
  return wait(5,"{}") ? 0 : -98;
}
extern "C" int bambu_network_get_user_print_info(void*,unsigned int* http,std::string* body) {
  *http=200;*body=R"({"devices":[{"dev_id":"20PTEST","dev_online":true}]})";return 0;
}
extern "C" int bambu_network_get_camera_url(void*,std::string,std::function<void(std::string)> callback) {
  callback(envOr("TEST_CLOUD_PROBE")=="rejected" ? "The specified resource is forbidden. [403]" : "bambu:///tutk/test?credential=PRIVATE_CAMERA_SECRET");return 0;
}
int main() {
  NativeApi api;
  api.handle=dlopen(nullptr,RTLD_NOW|RTLD_GLOBAL);
  api.createAgent=[](std::string)->void*{return reinterpret_cast<void*>(1);};
  api.destroyAgent=[](void*){return 0;};
  api.setConfigDir=[](void*,std::string){configured=true;return 0;};
  // Without init_log the plug-in's own account requests are unauthorized.
  api.initLog=[](void*){if(!configured)return -1;logInitialized=true;return 0;};
  api.setCertFile=[](void*,std::string,std::string){if(!logInitialized)return -1;certificatesSet=true;return 0;};
  api.setCountryCode=[](void*,std::string){return headersSet?0:-1;};
  api.setQueueOnMain=[](void*,std::function<void(std::function<void()>)>){return 0;};
  api.setMessage=[](void*,std::function<void(std::string,std::string)> fn){cloudMessage=fn;return 0;};
  api.setPrinterConnected=[](void*,std::function<void(std::string)> fn){printerConnected=fn;return 0;};
  api.installDeviceCert=[](void*,std::string,bool lanOnly){if(lanOnly)std::abort();};
  api.updateCert=[](void*){appCertUpdated=true;return 0;};
  api.start=[](void*){return logInitialized && headersSet ? 0 : -1;};
  api.connectPrinter=[](void*,std::string,std::string,std::string,std::string,bool){std::abort();return -1;};
  api.startLocalPrint=[](void*,BBL::PrintParams,BBL::OnUpdateStatusFn,BBL::WasCancelledFn){std::abort();return -1;};
  try { if(!envOr("TEST_CLOUD_PROBE").empty())runCloudProbe(api);else runOperation(api,NativeOperation::CloudPrint); }
  catch(const std::exception& error){std::cerr<<error.what()<<std::endl;return 1;}
}
`);
  const exportFlag=hostPlatform==='darwin'?'-Wl,-export_dynamic':'-Wl,--export-dynamic';
  const frameworks=hostPlatform==='darwin'?[fileURLToPath(new URL('../native/bambu-cloud-identity.cpp',import.meta.url)),'-framework','Security','-framework','CoreFoundation']:[];
  const build=spawnSync(process.env.CXX||'c++',['-std=c++17',driver,'-o',binary,exportFlag,'-ldl','-pthread',...frameworks],{encoding:'utf8',timeout:60000});
  assert.equal(build.status,0,build.stderr);
  process.env.BAMBU_NATIVE_HELPER=binary;process.env.BAMBU_NATIVE_PRINT_ROUTE='cloud';
  const receipt=path.join(s.directory,'receipt');
  const previous=process.env.TEST_CLOUD_RECEIPT;process.env.TEST_CLOUD_RECEIPT=receipt;
  t.after(()=>{if(previous===undefined)delete process.env.TEST_CLOUD_RECEIPT;else process.env.TEST_CLOUD_RECEIPT=previous;});
  const file=path.join(s.directory,'checked.3mf');await fs.writeFile(file,'stub plugin never reads this file');
  process.env.TEST_CLOUD_PROBE='rejected';
  try {
    await assert.rejects(probeBambuCloud('20PTEST'),/login succeeded.*signed camera-URL check was rejected/);
    process.env.TEST_CLOUD_PROBE='verified';
    const health=await probeBambuCloud('20PTEST');
    assert.equal(health.signed_camera_authorization,'verified');
    assert.equal(health.submission,'not_checked');
    assert.equal(health.physical_print,'not_checked');
    assert(!JSON.stringify(health).includes('PRIVATE_CAMERA_SECRET'));
    await assert.rejects(fs.stat(receipt),{code:'ENOENT'});
  } finally { delete process.env.TEST_CLOUD_PROBE; }
  const options={host:'127.0.0.1',serial:'20PTEST',token:'DUMMY',filePath:file,projectName:'test',presetName:'test',plateIndex:0,bedType:'textured_plate',useAMS:true,amsMapping:'[2]',nozzleMapping:'[1,0]'};
  let checks=0;
  process.env.TEST_CLOUD_MISSING_FLAGS='1';
  try {
    await assert.rejects(printWithBambuNative(options,undefined,{beforeDispatch:async()=>{checks++;}}),/capability report timed out before upload or dispatch; no job was submitted/);
    assert.equal(checks,0);await assert.rejects(fs.stat(receipt),{code:'ENOENT'});
  } finally { delete process.env.TEST_CLOUD_MISSING_FLAGS; }
  await assert.rejects(printWithBambuNative(options,undefined,{beforeDispatch:async()=>{if(++checks===2)throw new Error('Printer became busy');}}),/Printer became busy/);
  assert.equal(checks,2);await assert.rejects(fs.stat(receipt),{code:'ENOENT'});
  checks=0;
  const failureUpdates=[];
  process.env.TEST_CLOUD_UPLOAD_FAIL='1';
  try {
    await assert.rejects(printWithBambuNative(options,line=>failureUpdates.push(line),{beforeDispatch:async()=>{checks++;}}),error=>{
      assert.match(error.message,/do not automatically resend/);
      assert.match(error.message,/native_cloud_failure status=1 code=-3030 step=upload_3mf_config detail=-1 http=400/);
      assert.match(error.message,/native_print result=-3030/);
      assert(!error.message.includes('PRIVATE_SIGNED_URL'));
      return true;
    });
    assert.equal(checks,1);await assert.rejects(fs.stat(receipt),{code:'ENOENT'});
    assert(!failureUpdates.join('\n').includes('PRIVATE_SIGNED_URL'));
  } finally { delete process.env.TEST_CLOUD_UPLOAD_FAIL; }
  checks=0;
  assert.equal((await printWithBambuNative(options,undefined,{beforeDispatch:async()=>{checks++;}})).route,'bambu-cloud');
  assert.equal(checks,2);assert.equal(await fs.readFile(receipt,'utf8'),'submitted');
});
