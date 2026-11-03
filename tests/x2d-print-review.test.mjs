import assert from 'node:assert/strict';
import { test } from 'node:test';
import { X2dPrintReviews } from '../dist/x2d-print-review.js';

function setup() {
  let now=1000;
  const store=new X2dPrintReviews(()=>now);
  const input={host:'127.0.0.1',serial:'20PTEST',args:{plate_index:0,ams_slots:[1]},
    inspection:{sha256:'a'.repeat(64),plateInternalPath:'Metadata/plate_1.gcode'},
    state:{previousJob:['FINISH','previous'],filaments:[{slot:1,color:'161616FF'}]},
    preflight:{finishedJob:'previous',serial:'20PTEST',model:'x2d',notices:[]}};
  const review=store.prepare(input);
  const camera=store.recordCamera(input.host,input.serial);
  const request={approval_id:review.id,user_approved:true,user_approval:'Yes, print that black clip.',
    camera_capture_id:camera.id,plate_clear:true};
  return {store,input,review,camera,request,advance:ms=>{now+=ms;}};
}

test('print review expires after ten minutes even with a new camera image',()=>{
  const s=setup();s.advance(600_000);
  const camera=s.store.recordCamera(s.input.host,s.input.serial);
  assert.throws(()=>s.store.consume({...s.request,camera_capture_id:camera.id}),/review expired/);
});

test('camera evidence expires after two minutes and cannot be reused after rejection',()=>{
  const s=setup();s.advance(120_000);
  assert.throws(()=>s.store.consume(s.request),/older than two minutes/);
  assert.throws(()=>s.store.consume(s.request),/already used/);
});

test('camera from before job preparation, a different printer or an invented capture does not grant clearance',()=>{
  for(const mode of ['old','different','invented']) {
    const s=setup();
    if(mode==='old') {s.advance(1);s.request.approval_id=s.store.prepare(s.input).id;}
    if(mode==='different') s.request.camera_capture_id=s.store.recordCamera(s.input.host,'20POTHER').id;
    if(mode==='invented') s.request.camera_capture_id='invented';
    assert.throws(()=>s.store.consume(s.request),/camera capture from this printer/);
  }
});

test('a fresh inspected camera can replace the preview capture while approval is pending',()=>{
  const s=setup();s.advance(130_000);
  const camera=s.store.recordCamera(s.input.host,s.input.serial);
  const approval=s.store.consume({...s.request,camera_capture_id:camera.id});
  assert.equal(approval.camera.id,camera.id);
  s.store.assertMatches(approval,s.input.host,s.input.serial,s.input.inspection,s.input.state);
  s.advance(120_000);
  assert.throws(()=>s.store.assertMatches(approval,s.input.host,s.input.serial,s.input.inspection,s.input.state),/older than two minutes/);
});

test('approval requires both explicit user consent and a separate visual plate check',()=>{
  for(const changes of [{user_approved:false},{user_approval:' '},{plate_clear:false}]) {
    const s=setup();
    assert.throws(()=>s.store.consume({...s.request,...changes}),/approval.*required|plate is clear/);
  }
});

test('review stores a copy, binds file and plate, and disappears on restart or cancellation',()=>{
  const s=setup();
  s.input.args.ams_slots[0]=3;
  const approval=s.store.consume(s.request);
  assert.deepEqual(approval.review.args.ams_slots,[1]);
  for(const inspection of [{...s.input.inspection,sha256:'b'.repeat(64)},{...s.input.inspection,plateInternalPath:'Metadata/plate_2.gcode'}]) {
    assert.throws(()=>s.store.assertMatches(approval,s.input.host,s.input.serial,inspection,s.input.state),/file, plate or printer changed/);
  }
  assert.throws(()=>new X2dPrintReviews().consume(s.request),/Unknown/);
  const fresh=setup();fresh.store.invalidate();
  assert.throws(()=>fresh.store.consume(fresh.request),/Unknown/);
});
