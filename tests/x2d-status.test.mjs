import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { compactX2dStatus, connectorBuildId, X2dJobHistory } from '../dist/x2d-status.js';

const start=Date.parse('2026-01-01T12:00:00Z');
function observation(id='a',state='RUNNING',at=start,overrides={}) {
  return compactX2dStatus({connected:true,serial:'20PTEST',model:'X2D',status:state,
    observation:{receivedAt:at,requestedAt:at-1},
    print:{filename:'shoe organizer',progress:61,timeRemaining:58,currentLayer:255,totalLayers:419},
    raw:{task_id:id,subtask_id:id,print_error:0,hms:[],...overrides}},at);
}
function directory(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bambu-job-history-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}

test('compact status preserves job identity and errors without raw module/filament payloads',()=>{
  const result=observation('cloud-id','PAUSE',start,{print_error:123,hms:[{attr:1,code:2}],modules:Array(500).fill({name:'ota'}),ams:{tray_now:'2',ams:[{tray:Array(4).fill({})}]}});
  assert.equal(result.print.stage,'paused');
  assert.equal(result.print.task_id,'cloud-id');
  assert.equal(result.print.time_remaining_unit,'minutes');
  assert.equal(result.active_ams_slot,2);
  assert.equal(result.errors.print_error,123);
  assert.deepEqual(result.errors.hms,[{attr:1,code:2}]);
  assert.equal(result.raw,undefined);
  assert(JSON.stringify(result).length<1500);
});

test('a new job does not report the previous job layer as printing',()=>{
  // Observed on the X2D one second after cloud dispatch: RUNNING with the new
  // job, the earlier cube's layer 50, no stage entered and heaters still off.
  const status=(stg_cur,progress,currentLayer)=>compactX2dStatus({connected:true,serial:'20PTEST',model:'X2D',status:'RUNNING',
    observation:{receivedAt:start,requestedAt:start-1},print:{filename:'cable clips',progress,timeRemaining:0,currentLayer,totalLayers:87},
    raw:{task_id:'new',stg_cur}},start);
  const arrived=status(-1,0,50);
  assert.equal(arrived.print.stage,'preparing');
  assert.equal(arrived.print.currentLayer,null);
  assert.equal(status(4,0,0).print.stage,'preparing');
  const printing=status(0,51,3);
  assert.equal(printing.print.stage,'printing');
  assert.equal(printing.print.currentLayer,3);
});

test('unknown telemetry is not reported as fresh or error-free',()=>{
  const unknown=compactX2dStatus({status:'UNKNOWN',connected:true},start);
  assert.equal(unknown.observation.stale,true);
  assert.equal(unknown.errors.print_error,null);
  assert.equal(unknown.errors.hms,null);
  assert.equal(unknown.print.progress,null);
  const stale=compactX2dStatus({status:'RUNNING',connected:true,observation:{receivedAt:start}},start+31_000);
  assert.equal(stale.observation.stale,true);
  assert.equal(stale.observation.age_ms,31_000);
});

test('external jobs survive restart and a missing ending is never inferred as completion',t=>{
  const dir=directory(t);
  let history=new X2dJobHistory(dir);
  const first=history.observe(observation());
  assert(first.current_job_id);
  history.close();
  history=new X2dJobHistory(dir);t.after(()=>history.close());
  assert.equal(history.list('20PTEST').jobs[0].id,first.current_job_id);
  history.observe(observation('b','RUNNING',start+1000));
  let jobs=history.list('20PTEST').jobs;
  assert.equal(jobs.length,2);
  assert.equal(jobs[1].outcome,'unknown');
  assert.equal(jobs[1].terminal_observed_at,null);
  history.observe(observation('b','FINISH',start+2000));
  jobs=history.list('20PTEST').jobs;
  assert.equal(jobs.length,2);
  assert.equal(jobs[0].outcome,'finished');
  assert.equal(jobs[0].terminal_observed_at,new Date(start+2000).toISOString());
  assert.equal(history.list('OTHER').jobs.length,0);
});

test('two connector sessions preserve both jobs and reject older cached observations',t=>{
  const dir=directory(t);
  const a=new X2dJobHistory(dir),b=new X2dJobHistory(dir);t.after(()=>{a.close();b.close();});
  a.observe(observation('a','RUNNING',start));
  b.observe(observation('b','RUNNING',start+2000));
  assert.equal(a.observe(observation('a','RUNNING',start+1000)).recorded,false);
  assert.equal(a.list('20PTEST').jobs[0].latest.print.task_id,'b');
  assert.equal(a.list('20PTEST').jobs.length,2);
  const stale=observation('c','RUNNING',start+3000);stale.observation.stale=true;
  assert.equal(b.observe(stale).recorded,false);
  assert.equal(b.list('20PTEST').jobs.length,2);
});

test('reprinting a filename without a printer job ID creates a distinct run after finish',t=>{
  const history=new X2dJobHistory(directory(t));t.after(()=>history.close());
  history.observe(observation('0','RUNNING',start));
  history.observe(observation('0','FINISH',start+1000));
  history.observe(observation('0','RUNNING',start+2000));
  const jobs=history.list('20PTEST').jobs;
  assert.equal(jobs.length,2);
  assert.notEqual(jobs[0].id,jobs[1].id);
  assert.equal(jobs[0].latest.print.identity_quality,'filename');
  assert.equal(jobs[1].outcome,'finished');
});

test('idle clears the tracked current job without inventing a successful ending',t=>{
  const history=new X2dJobHistory(directory(t));t.after(()=>history.close());
  history.observe(observation());
  assert.equal(history.observe(observation('a','IDLE',start+1000)).current_job_id,null);
  const data=history.list('20PTEST');
  assert.equal(data.last_observed_job_id,null);
  assert.equal(data.jobs.length,1);
  assert.equal(data.jobs[0].outcome,'unknown');
});

test('history retains cancelled outcomes, bounds retention, and never stores arbitrary raw payloads',t=>{
  const history=new X2dJobHistory(directory(t));t.after(()=>history.close());
  for(let i=0;i<105;i++) history.observe(observation(String(i+1),'FAILED',start+i,{fail_reason:'0300400C',unrelated_secret:'not-for-history'}));
  const jobs=history.list('20PTEST',50).jobs;
  assert.equal(jobs.length,50);
  assert.equal(jobs[0].outcome,'cancelled');
  assert.equal(JSON.stringify(jobs).includes('not-for-history'),false);
  assert.throws(()=>history.list('20PTEST',51),/limit/);
  assert.equal(fs.statSync(path.join(history.directory,'jobs.sqlite')).mode&0o777,0o600);
  const db=new DatabaseSync(path.join(history.directory,'jobs.sqlite'),{readOnly:true});
  assert.equal(db.prepare('SELECT count(*) AS count FROM jobs').get().count,100);
  db.close();
});

test('build fingerprints detect deployed JS changes and ignore unrelated files',t=>{
  const dir=directory(t);fs.mkdirSync(path.join(dir,'nested'));
  fs.writeFileSync(path.join(dir,'index.js'),'one');fs.writeFileSync(path.join(dir,'nested','status.js'),'two');
  const original=connectorBuildId(dir);
  fs.writeFileSync(path.join(dir,'README.md'),'not runtime code');
  assert.equal(connectorBuildId(dir),original);
  fs.writeFileSync(path.join(dir,'nested','status.js'),'new');
  assert.notEqual(connectorBuildId(dir),original);
});
