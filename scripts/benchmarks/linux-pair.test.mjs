import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { gunzipSync } from 'node:zlib';
import ts from 'typescript';
import { evidenceFrame } from './linux-pair-evidence.mjs';
const DRIVER = fileURLToPath(new URL('./linux-pair.mjs', import.meta.url));
function fixture(t, differentConfig = false) {
  const root = mkdtempSync(join(tmpdir(), 'hh-pair-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), bin = join(root, 'bin'); mkdirSync(repo);mkdirSync(bin);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'task-378-fixture');
  for (const dir of ['apps/node','apps/server','apps/web','packages/protocol']) {mkdirSync(join(repo,dir),{recursive:true});writeFileSync(join(repo,dir,'package.json'),'{}\n');}
  writeFileSync(join(repo,'.gitignore'),'.metrics/\nnode_modules/\n**/dist/\n');
  writeFileSync(join(repo,'package.json'),'{"private":true}\n');writeFileSync(join(repo,'package-lock.json'),'{}\n');
  writeFileSync(join(repo,'apps/node/vitest.config.ts'),'export default {};\n');
  const commit = () => { git('add','.');git('-c','user.name=Ivan Korol','-c','user.email=invariant0x@icloud.com','commit','-m','Fixture');return git('rev-parse','HEAD'); };
  mkdirSync(join(repo,'scripts'),{recursive:true});writeFileSync(join(repo,'scripts/check-release.mjs'),'// Fixture release check\n');
  mkdirSync(join(repo,'apps/node/src'),{recursive:true});
  writeFileSync(join(repo,'apps/node/src/cli.js'),"process.stdout.write('control');\n");
  const control = commit();mkdirSync(join(repo,'apps/node/test'),{recursive:true});writeFileSync(join(repo,'apps/node/test/optimized.ts'),'// clock optimization\n');
  writeFileSync(join(repo,'apps/node/src/cli.js'),"process.stdout.write('optimized');\n");
  if(differentConfig)writeFileSync(join(repo,'apps/node/vitest.config.ts'),'export default { changed: true };\n');
  const optimized = commit();
  const stub = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const tool=path.basename(process.argv[1]),args=process.argv.slice(2),cwd=process.cwd();
const row={tool,args,cwd,sha:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),part:process.env.HH_TEST_PART,parts:process.env.HH_TEST_PARTS,variant:process.env.HH_PAIR_VARIANT,cache:process.env.npm_config_cache,workers:process.env.VITEST_MAX_WORKERS};
if(tool==='npm'&&args[0]==='ci') {row.cacheWasEmpty=fs.readdirSync(row.cache).length===0;fs.writeFileSync(path.join(row.cache,'fixture-marker'),'warm');}
fs.appendFileSync(process.env.HH_PAIR_TRACE,JSON.stringify(row)+'\\n');
if(process.env.HH_PAIR_FIXTURE_SETUP_FAIL&&row.variant==='control'&&row.part==='1'&&tool==='npm'&&args[0]==='ci') {console.error('SETUP failed');process.exit(1);}
if(process.env.HH_PAIR_FIXTURE_PAUSE&&row.variant==='control'&&row.part==='1'&&tool==='npm'&&args[0]==='ci') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5500);
if(process.env.HH_PAIR_FIXTURE_DRIFT&&row.variant==='control'&&row.part==='1'&&tool==='npm'&&args[0]==='ci') {console.log('completed command before quota drift');fs.writeFileSync(process.env.HH_PAIR_QUOTA_MARKER,'drift');}
if(tool==='npm'&&args[0]==='run'&&args[1]==='build'&&args.includes('@hornhoof/protocol')) {fs.mkdirSync(path.join(cwd,'packages/protocol/dist'),{recursive:true});fs.writeFileSync(path.join(cwd,'packages/protocol/dist/ready'),'built');}
if(tool==='npm'&&args[0]==='run'&&args[1]==='build'&&args.includes('@hornhoof/node')) {
 if(process.env.HH_PAIR_FIXTURE_NODE_BUILD_FAIL&&row.variant==='control'&&row.part==='1') {console.error('NODE BUILD failed');process.exit(1);}
 if(!fs.existsSync(path.join(cwd,'packages/protocol/dist/ready'))) {console.error('protocol prerequisite missing');process.exit(1);}
 fs.mkdirSync(path.join(cwd,'apps/node/dist'),{recursive:true});fs.copyFileSync(path.join(cwd,'apps/node/src/cli.js'),path.join(cwd,'apps/node/dist/check-command.js'));
}
if(tool==='npx'||(tool==='npm'&&args[0]==='test')) {
 const root=cp.execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();
 const cli=cp.spawnSync(process.execPath,[path.join(root,'apps/node/dist/check-command.js')],{encoding:'utf8'});
 if(cli.status!==0||cli.stdout!==row.variant) {console.error(cli.stderr||'wrong source CLI artifact');process.exit(1);}
 const pkg=cwd.endsWith('protocol')||args.includes('@hornhoof/protocol')?'packages/protocol':cwd.slice(cwd.lastIndexOf('apps/'));
 if(process.env.HH_PAIR_FIXTURE_MALFORMED&&row.variant==='control'&&row.part==='1'&&pkg==='apps/server') console.log('::hh-test-timing::{broken}');
 if(process.env.HH_PAIR_FIXTURE_BINARY&&row.variant==='control'&&row.part==='2'&&pkg==='apps/server') process.stdout.write(Buffer.from([0,255,195,40,10]));
 console.log('::hh-test-timing::'+JSON.stringify({kind:'file',package:pkg,file:'test/example.test.ts',totalMs:10,setupMs:2,testsMs:8,teardownMs:0,slowest:[]}));
 const summary='::hh-test-timing::'+JSON.stringify({kind:'package',package:pkg,tests:3,medianTestMs:1,slowerThanMedian:1});
 if(!(process.env.HH_PAIR_FIXTURE_OMIT&&pkg==='apps/server'&&row.part==='2')) console.log(summary);
 if(process.env.HH_PAIR_FIXTURE_DUPLICATE&&pkg==='apps/server'&&row.part==='2') console.log(summary);
 if(process.env.HH_PAIR_FIXTURE_VOLUME) for(let i=0;i<120;i++) console.log('::hh-test-timing::'+JSON.stringify({kind:'file',package:pkg,file:'test/realistic-file-'+i+'.test.ts',totalMs:i*100,setupMs:i*10,testsMs:i*90,teardownMs:0,slowest:[]}));
}
if(process.env.HH_PAIR_FIXTURE_FAIL&&row.variant==='optimized'&&row.part==='2'&&tool==='npx'&&cwd.endsWith('apps/server')) {console.error('FAIL retained fixture error');process.exitCode=1;}
if(process.env.HH_PAIR_FIXTURE_VOLUME&&row.variant==='control'&&row.part==='2'&&tool==='npx'&&cwd.endsWith('apps/server')) {console.error('FAIL middle-stage diagnostic marker');console.log('x'.repeat(4*1024*1024));process.exitCode=1;}
if(process.env.HH_PAIR_FIXTURE_BUDGET&&row.variant==='control'&&row.part==='2'&&tool==='npx'&&cwd.endsWith('apps/server')) console.log(require('node:crypto').randomBytes(800*1024).toString('base64'));
`;
  for(const tool of ['npm','npx','node','bash','shellcheck']) if(tool!=='node')writeFileSync(join(bin,tool),stub,{mode:0o755});
  const out=join(root,'out');mkdirSync(out);
  return { root, repo, control, optimized, out, trace:join(root,'trace.jsonl'), env:{...process.env,PATH:bin+':'+process.env.PATH,HH_PAIR_TRACE:join(root,'trace.jsonl'),HH_OUT:out} };
}
function run(f, env={}) {const result=spawnSync(process.execPath,[DRIVER,f.control,f.optimized],{cwd:f.repo,env:{...f.env,...env},encoding:'utf8',timeout:30000,maxBuffer:32*1024*1024});return {...result,records:result.stdout.split('\n').filter(l=>l.startsWith('HH_PAIR_')).map(l=>{const at=l.indexOf(' ');return {kind:l.slice(0,at),...JSON.parse(l.slice(at+1))};})};}
test('builds both fresh source CLIs before suites and excludes builds from suite time',t=>{
 const f=fixture(t),r=run(f);const trace=readFileSync(f.trace,'utf8').trim().split('\n').map(JSON.parse);
 const builds=trace.filter(x=>x.tool==='npm'&&x.args[0]==='run'&&x.args[1]==='build'&&x.args.includes('@hornhoof/node'));
 assert.equal(builds.length,8,'every fresh logical source must build its node CLI');assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
 const stages=r.records.filter(x=>x.kind==='HH_PAIR_STAGE');assert.equal(stages.length,62);
 for(const v of ['control','optimized']) {
  assert.equal(stages.filter(x=>x.variant===v&&x.phase==='preparation').length,12);
  const result=r.records.find(x=>x.kind==='HH_PAIR_RESULT');
  assert.equal(result.times[v].suiteMs,stages.filter(x=>x.variant===v&&x.phase==='suite').reduce((n,x)=>n+x.ms,0));
  assert.ok(stages.filter(x=>x.stage==='node-build').every(x=>x.phase==='preparation'));
 }
});
test('requires durable output storage before executing any commands',t=>{
 const f=fixture(t),r=run(f,{HH_OUT:''});assert.equal(r.status,1);
 assert.equal(r.records.filter(x=>x.kind==='HH_PAIR_STAGE').length,0);
 assert.ok(r.records.some(x=>x.kind==='HH_PAIR_INVALID'));
});
test('retains all bytes above the console budget in checksummed output files',t=>{
 const f=fixture(t),r=run(f,{HH_PAIR_FIXTURE_BUDGET:'1'});assert.equal(r.status,0,r.stderr);
 const frame=r.records.find(x=>x.kind==='HH_PAIR_EVIDENCE');assert.ok(frame.artifacts,'frame must refer to complete output artifacts');
 assert.ok(Buffer.byteLength(JSON.stringify(frame))<700*1024);
 const artifact=frame.artifacts.find(x=>x.name.endsWith('.gz'));const bytes=readFileSync(join(f.out,artifact.name));
 assert.equal(bytes.length,artifact.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),artifact.sha256);
 const rows=gunzipSync(bytes).toString().trim().split('\n').map(JSON.parse);
 assert.equal(rows.filter(x=>x.kind==='HH_PAIR_OUTPUT').length,62);
 assert.ok(rows.some(x=>x.kind==='HH_PAIR_OUTPUT'&&x.value.output.length>800*1024));
});
test('keeps raw command bytes even when output is not valid UTF8',t=>{
 const f=fixture(t),r=run(f,{HH_PAIR_FIXTURE_BINARY:'1'});assert.equal(r.status,0,r.stderr);
 const raw=readFileSync(join(f.repo,'.metrics/paired-tests/control-2-apps_server.log'));
 assert.ok(raw.includes(Buffer.from([0,255,195,40,10])),'the raw file must preserve the child bytes');
 const row=decodeEvidence(r.stdout,f.out).find(x=>x.kind==='HH_PAIR_OUTPUT'&&x.value.variant==='control'&&x.value.part===2&&x.value.stage==='apps/server');
 assert.equal(row.value.rawSha256,createHash('sha256').update(raw).digest('hex'));
 assert.deepEqual(Buffer.from(row.value.rawBase64,'base64'),raw);
});
test('a failed node build prevents suite commands in that fresh source',t=>{
 const f=fixture(t),r=run(f,{HH_PAIR_FIXTURE_NODE_BUILD_FAIL:'1'});assert.equal(r.status,1);
 const trace=readFileSync(f.trace,'utf8').trim().split('\n').map(JSON.parse);
 assert.ok(!trace.some(x=>x.variant==='control'&&x.part==='1'&&(x.tool==='npx'||x.args[0]==='test')));
 const result=r.records.find(x=>x.kind==='HH_PAIR_RESULT');assert.equal(result.complete,false);assert.equal(result.valid,false);
 assert.ok(result.failures.some(x=>x.stage==='node-build'&&x.phase==='preparation'));
});
test('retains completed-stage evidence when timing parsing fails',t=>{
 const f=fixture(t),r=run(f,{HH_PAIR_FIXTURE_MALFORMED:'1'});assert.equal(r.status,1);
 const rows=decodeEvidence(r.stdout,f.out);
 const output=rows.find(x=>x.kind==='HH_PAIR_OUTPUT'&&x.value.variant==='control'&&x.value.part===1&&x.value.stage==='apps/server');
 assert.ok(output,'completed raw output must survive a parser failure');assert.match(output.value.output,/\{broken\}/);
 const stage=rows.find(x=>x.kind==='HH_PAIR_STAGE'&&x.value.variant==='control'&&x.value.part===1&&x.value.stage==='apps/server').value;
 assert.equal(stage.exitCode,0);assert.ok(stage.ms>0);assert.equal(stage.timingValid,false);assert.match(stage.validationError,/timing/i);
});
test('retains completed-stage evidence when observed quota identity drifts',t=>{
 const f=fixture(t),preload=join(f.root,'quota.mjs'),marker=join(f.root,'quota-marker');
 writeFileSync(preload,"import os from 'node:os';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const cpu=os.availableParallelism();os.availableParallelism=()=>cpu+(fs.existsSync(process.env.HH_PAIR_QUOTA_MARKER)?1:0);syncBuiltinESMExports();\n");
 const r=run(f,{HH_PAIR_FIXTURE_DRIFT:'1',HH_PAIR_QUOTA_MARKER:marker,NODE_OPTIONS:'--import='+preload});assert.equal(r.status,1);
 const rows=decodeEvidence(r.stdout,f.out);
 const output=rows.find(x=>x.kind==='HH_PAIR_OUTPUT');assert.ok(output,'raw output must survive quota drift');assert.match(output.value.output,/completed command/);
 const stage=rows.find(x=>x.kind==='HH_PAIR_STAGE').value;assert.equal(stage.exitCode,0);assert.ok(stage.ms>0);assert.equal(stage.timingValid,false);assert.match(stage.validationError,/identity|quota|limits/i);
 assert.equal(r.records.filter(x=>x.kind==='HH_PAIR_STAGE').length,1);
});
test('runs both pinned commits as eight isolated logical shards with all original stages', t=>{
 const f=fixture(t),r=run(f);assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
 const trace=readFileSync(f.trace,'utf8').trim().split('\n').map(JSON.parse);assert.equal(trace.length,60);
 const installs=trace.filter(x=>x.tool==='npm'&&x.args[0]==='ci');assert.equal(installs.length,8);assert.equal(new Set(installs.map(x=>x.cwd)).size,8);assert.equal(new Set(installs.map(x=>x.cache)).size,8);assert.ok(installs.every(x=>x.cacheWasEmpty));
 const tests=trace.filter(x=>x.tool==='npx');assert.equal(tests.length,24);
 for(const x of tests){assert.equal(x.sha,x.variant==='control'?f.control:f.optimized);assert.equal(x.parts,'4');assert.deepEqual(x.args,['--no-install','vitest','run','--shard='+x.part+'/4','--maxWorkers=2']);}
 const result=r.records.find(x=>x.kind==='HH_PAIR_RESULT');assert.equal(result.valid,true);assert.equal(result.failed,false);assert.deepEqual(result.counts.control,{'packages/protocol':3,'apps/server':12,'apps/node':12,'apps/web':12});assert.deepEqual(result.counts.optimized,result.counts.control);
 assert.ok(decodeEvidence(r.stdout,f.out).some(x=>x.kind==='HH_PAIR_RESOURCE'));assert.equal(r.records.filter(x=>x.kind==='HH_PAIR_STAGE').length,62);
});
test('retains a failed stage and still records both variants without retries',t=>{
 const f=fixture(t),r=run(f,{HH_PAIR_FIXTURE_FAIL:'1'});assert.equal(r.status,1);
 assert.ok(decodeEvidence(r.stdout,f.out).some(x=>x.kind==='HH_PAIR_OUTPUT'&&x.value.output.includes('FAIL retained fixture error')));
 const result=r.records.find(x=>x.kind==='HH_PAIR_RESULT');assert.equal(result.failed,true);assert.equal(result.failures.length,1);assert.equal(result.failures[0].part,2);assert.equal(result.failures[0].variant,'optimized');
 assert.equal(r.records.filter(x=>x.kind==='HH_PAIR_STAGE').length,62);
});
test('rejects a changed package/config before executing benchmark stages',t=>{
 const f=fixture(t,true),r=run(f);assert.equal(r.status,1);assert.ok(r.records.some(x=>x.kind==='HH_PAIR_INVALID'));assert.equal(r.records.filter(x=>x.kind==='HH_PAIR_STAGE').length,0);
});
test('rejects different node build options before installing either source',t=>{
 const f=fixture(t);writeFileSync(join(f.repo,'apps/node/tsconfig.json'),'{"compilerOptions":{"target":"ES2022"}}\n');
 execFileSync('git',['add','apps/node/tsconfig.json'],{cwd:f.repo});
 execFileSync('git',['-c','user.name=Ivan Korol','-c','user.email=invariant0x@icloud.com','commit','-m','Different build config'],{cwd:f.repo,stdio:'ignore'});
 f.optimized=execFileSync('git',['rev-parse','HEAD'],{cwd:f.repo,encoding:'utf8'}).trim();
 const r=run(f);assert.equal(r.status,1);assert.equal(r.records.filter(x=>x.kind==='HH_PAIR_STAGE').length,0);
});

test('marks setup failure incomplete rather than validating empty or partial counts',t=>{
 const f=fixture(t),r=run(f,{HH_PAIR_FIXTURE_SETUP_FAIL:'1'});assert.equal(r.status,1);
 const result=r.records.find(x=>x.kind==='HH_PAIR_RESULT');assert.equal(result.complete,false);assert.equal(result.valid,false);assert.equal(result.failed,true);
});
test('samples resources during a child command and archives complete timing evidence at the end',t=>{
 const f=fixture(t),r=run(f,{HH_PAIR_FIXTURE_PAUSE:'1'});assert.equal(r.status,0,r.stderr);
 const rows=decodeEvidence(r.stdout,f.out);assert.equal(rows.filter(x=>x.kind==='HH_PAIR_STAGE').length,62);
 assert.equal(rows.filter(x=>x.kind==='HH_PAIR_OUTPUT').length,62);
 assert.ok(rows.some(x=>x.kind==='HH_PAIR_RESOURCE'&&x.value.point==='during'));
 assert.equal(rows.at(-1).kind,'HH_PAIR_RESULT');
});
test('keeps the existing frame limit and rejects oversized metadata without trimming it',()=>{
 const within=evidenceFrame({note:'x'.repeat(716600)},[]);assert.ok(Buffer.byteLength(within+'\n')<=716800);
 assert.throws(()=>evidenceFrame({note:'x'.repeat(716800)},[]),/700 KiB runner tail budget/);
});

test('limits protocol and app test commands to two workers even on a larger host',t=>{
 const f=fixture(t),r=run(f,{VITEST_MAX_WORKERS:'9'});assert.equal(r.status,0,r.stderr);
 const trace=readFileSync(f.trace,'utf8').trim().split('\n').map(JSON.parse);
 const tests=trace.filter(x=>x.tool==='npx'||(x.tool==='npm'&&x.args[0]==='test'));assert.equal(tests.length,26);
 assert.ok(tests.every(x=>x.workers==='2'&&x.args.includes('--maxWorkers=2')));
});
for(const fault of ['OMIT','DUPLICATE']) test('rejects the same '+fault.toLowerCase()+' shard summary in both variants',t=>{
 const f=fixture(t),r=run(f,{['HH_PAIR_FIXTURE_'+fault]:'1'});assert.equal(r.status,1);
 const result=r.records.find(x=>x.kind==='HH_PAIR_RESULT');assert.equal(result.valid,false);assert.equal(result.complete,false);
 assert.equal(r.records.filter(x=>x.kind==='HH_PAIR_STAGE').length,62);
});

function decodeEvidence(output, folder) {
 const line=output.split('\n').findLast(x=>x.startsWith('HH_PAIR_EVIDENCE '));assert.ok(line,'compressed evidence must be present');
 const frame=JSON.parse(line.slice('HH_PAIR_EVIDENCE '.length));assert.ok(Buffer.byteLength(line+'\n')<=700*1024,'manifest must fit the runner tail budget');
 assert.equal(frame.artifacts.length,2);
 for(const artifact of frame.artifacts){const bytes=readFileSync(join(folder,artifact.name));assert.equal(bytes.length,artifact.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),artifact.sha256);}
 const plain=readFileSync(join(folder,'pair-evidence.ndjson'));
 assert.deepEqual(gunzipSync(readFileSync(join(folder,'pair-evidence.ndjson.gz'))),plain);
 return plain.toString().trim().split('\n').map(JSON.parse);
}
test('preserves middle failures, every file and resource sample through the actual runner log limit',t=>{
 const f=fixture(t),r=run(f,{HH_PAIR_FIXTURE_VOLUME:'1',HH_PAIR_FIXTURE_PAUSE:'1'});assert.equal(r.status,1);
 const source=readFileSync(new URL('../../apps/node/src/tests.ts',import.meta.url),'utf8');
 const protocol=readFileSync(new URL('../../packages/protocol/src/index.ts',import.meta.url),'utf8');
 const max=Number(protocol.match(/export const TEST_LOG_BYTES = (.*);/)[1].split('*').map(Number).reduce((a,b)=>a*b,1));
 const klass=source.slice(source.indexOf('class Output {'),source.indexOf('\ntype Ended ='));
 const code=ts.transpile(klass+'\nnew Output()', {target:ts.ScriptTarget.ES2022});
 const output=runInNewContext(code,{Buffer,TEST_LOG_BYTES:max});
 const text='x'.repeat(4*1024*1024)+'\n'+r.stdout;
 for(let i=0;i<text.length;i+=8192) output.add(Buffer.from(text.slice(i,i+8192)));
 const bounded=output.text();assert.match(bounded,/bytes left out/);assert.ok(Buffer.byteLength(bounded)<max+1024);
 const rows=decodeEvidence(bounded,f.out);
 assert.equal(rows.filter(x=>x.kind==='HH_PAIR_STAGE').length,62);
 assert.equal(rows.filter(x=>x.kind==='HH_PAIR_TIMING'&&x.value.kind==='file').length,26*121);
 for(const stage of r.records.filter(x=>x.kind==='HH_PAIR_STAGE')) {
  const resources=rows.filter(x=>x.kind==='HH_PAIR_RESOURCE'&&x.value.variant===stage.variant&&x.value.part===stage.part&&x.value.stage===stage.stage);
  assert.equal(resources.length,stage.resources.samples);
  for(const point of ['before','after'])assert.equal(resources.filter(x=>x.value.point===point).length,1);
 }
 assert.ok(rows.some(x=>x.kind==='HH_PAIR_FAILED_OUTPUT'&&x.value.output.includes('FAIL middle-stage diagnostic marker')));
 assert.equal(rows.at(-1).value.failed,true);
});
