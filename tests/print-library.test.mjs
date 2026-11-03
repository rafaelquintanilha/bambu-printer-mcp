import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import JSZip from 'jszip';
import { PrintLibrary, inspectSavedFile, makerworldUrl } from '../dist/print-library.js';

const model = {url:'https://makerworld.com/en/models/123-test-model#profileId-99',title:'Test model',design_id:'USidentity'};
const collection = {collection_url:'https://makerworld.com/en/collections/456-test',title:'Saved models',expected_model_count:1,models:[model]};
async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'bambu-library-'));
  const root = path.join(directory,'models'); await fs.mkdir(root);
  const library = new PrintLibrary(path.join(directory,'state'),[root]);
  t.after(async()=>{library.close();await fs.rm(directory,{recursive:true,force:true});});
  return {directory,root,library};
}
async function artifact(file,{prepared=true,title='Test model',id='USidentity',support='normal(auto)'}={}) {
  const zip=new JSZip();
  zip.file('3D/3dmodel.model',`<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="DesignModelId">${id}</metadata><metadata name="DesignProfileId">99</metadata><metadata name="Title">${title}</metadata><metadata name="ProfileTitle">0.2 mm</metadata><resources/><build/></model>`);
  zip.file('Metadata/project_settings.config',JSON.stringify({printer_model:'Bambu Lab X2D',nozzle_diameter:['0.4','0.4'],filament_type:['PLA'],filament_colour:['#FFF144'],support_type:support}));
  if(prepared){
    zip.file('Metadata/plate_1.gcode','; printer_model = Bambu Lab X2D\nG1 X0 Y0\n');
    zip.file('Metadata/slice_info.config','<config><plate><metadata key="index" value="1"/><metadata key="prediction" value="600"/><metadata key="weight" value="4.5"/><object name="Object one"/></plate></config>');
  }
  await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));
}

test('model URLs canonicalize without accepting lookalike hosts or arbitrary schemes',()=>{
  assert.equal(makerworldUrl(model.url,'models'),'https://makerworld.com/en/models/123');
  for(const url of ['https://makerworld.com.evil.test/en/models/123','http://makerworld.com/en/models/123','https://user@makerworld.com/en/models/123','file:///models/123'])assert.throws(()=>makerworldUrl(url,'models'));
});

test('design identity links a renamed saved file to its MakerWorld URL and groups identical copies',async t=>{
  const s=await setup(t);
  const file=path.join(s.root,'renamed.3mf');await artifact(file,{title:'Renamed in Studio'});
  await fs.copyFile(file,path.join(s.root,'copy.3mf'));
  s.library.saveCollection(collection);
  const result=await s.library.find(model.url);
  assert.equal(result.matching_models,1);assert.equal(result.matching_files,1);
  assert.equal(result.files[0].paths.length,2);assert.equal(result.files[0].matches[0].match,'design_id');
  assert.equal(result.files[0].plates[0].estimated_seconds,600);
  assert.equal(result.dispatch_authorized,false);assert.equal(result.live_makerworld,false);
});

test('sources and different support variants remain distinct while title-only matches are labeled',async t=>{
  const s=await setup(t);s.library.saveCollection({...collection,models:[{url:model.url,title:model.title}]});
  await artifact(path.join(s.root,'source.3mf'),{prepared:false});
  await artifact(path.join(s.root,'normal.3mf'));
  await artifact(path.join(s.root,'tree.3mf'),{support:'tree(auto)'});
  const result=await s.library.find(model.url);
  assert.equal(result.matching_files,3);
  assert.equal(result.files.filter(file=>file.kind==='prepared_3mf').length,2);
  assert.equal(result.files.at(-1).kind,'source_project');
  assert(result.files.every(file=>file.matches[0].match==='title'));
  assert.deepEqual(new Set(result.files.map(file=>file.settings.support_type)),new Set(['normal(auto)','tree(auto)']));
});

test('conflicting design IDs never become an automatic title match',async t=>{
  const s=await setup(t);s.library.saveCollection(collection);
  await artifact(path.join(s.root,'same-title.3mf'),{id:'USdifferent'});
  assert.equal((await s.library.find(model.url)).matching_files,0);
});

test('different non-Latin titles never collapse into an empty title match',async t=>{
  const s=await setup(t);s.library.saveCollection({...collection,models:[{url:model.url,title:'模型甲'}]});
  await artifact(path.join(s.root,'different.3mf'),{id:'',title:'模型乙'});
  assert.equal((await s.library.find(model.url)).matching_files,0);
});

test('collection membership updates and cache survive restart; deleted/changed files are refreshed',async t=>{
  const s=await setup(t);s.library.saveCollection(collection);
  const file=path.join(s.root,'saved.3mf');await artifact(file);
  const first=(await s.library.find(model.url)).files[0].sha256;
  const reopened=new PrintLibrary(path.join(s.directory,'state'),[s.root]);
  try{assert.equal((await reopened.find(model.url)).files[0].sha256,first);}finally{reopened.close();}
  await artifact(file,{support:'tree(auto)'});
  assert.notEqual((await s.library.find(model.url)).files[0].sha256,first);
  await fs.rm(file);assert.equal((await s.library.find(model.url)).matching_files,0);
  assert.throws(()=>s.library.saveCollection({...collection,expected_model_count:33}),/incomplete/);
  assert.equal((await s.library.find()).matching_models,1);
  s.library.saveCollection({...collection,expected_model_count:0,models:[]});assert.equal((await s.library.find()).matching_models,0);
});

test('a corrupt file is reported without hiding valid files or claiming a complete scan',async t=>{
  const s=await setup(t);await artifact(path.join(s.root,'valid.3mf'));await fs.writeFile(path.join(s.root,'bad.3mf'),'not a zip');
  const result=await s.library.find();
  assert.equal(result.files.length,1);assert.equal(result.scan_incomplete,true);assert.equal(result.warnings.length,1);
});

test('printer listing reports name and size agreement without claiming checksum or Handy verification',async t=>{
  const s=await setup(t);const file=path.join(s.root,'saved.3mf');await artifact(file);
  const size=(await fs.stat(file)).size;
  const report=await s.library.details(file,[{name:'checked-uuid-saved.3mf',path:'/userdata/model/history/saved.3mf',size},{name:'saved.3mf',path:'/userdata/model/history/other.3mf',size:size+1}]);
  assert.equal(report.printer_storage.matches.length,2);
  assert.deepEqual(report.printer_storage.matches.map(file=>file.size_matches),[true,false]);
  assert.equal(report.printer_storage.bytes_verified,false);assert.equal(report.printer_storage.handy_verified,false);
  assert.equal(report.dispatch_authorized,false);
});

test('library cancellation stops scanning without returning success',async t=>{
  const s=await setup(t);const controller=new AbortController();controller.abort();
  await assert.rejects(s.library.find('',10,controller.signal),/abort/i);
});

test('missing object metadata is unknown rather than a claim of zero printed objects',async t=>{
  const s=await setup(t);const file=path.join(s.root,'unknown-count.3mf');await artifact(file);
  const zip=await JSZip.loadAsync(await fs.readFile(file));zip.remove('Metadata/slice_info.config');
  await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));
  assert.equal((await inspectSavedFile(file)).plates[0].object_count,null);
});
