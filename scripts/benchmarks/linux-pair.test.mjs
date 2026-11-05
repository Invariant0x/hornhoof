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
const DRIVER = fileURLToPath(new URL('./linux-pair.mjs', import.meta.url));
function fixture(t, differentConfig = false) {
  const root = mkdtempSync(join(tmpdir(), 'hh-pair-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), bin = join(root, 'bin'); mkdirSync(repo);mkdirSync(bin);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'task-378-fixture');
  for (const dir of ['apps/node','apps/server','apps/web','packages/protocol']) {mkdirSync(join(repo,dir),{recursive:true});writeFileSync(join(repo,dir,'package.json'),'{}\n');}
  writeFileSync(join(repo,'.gitignore'),'.metrics/\nnode_modules/\n');
  writeFileSync(join(repo,'package.json'),'{"private":true}\n');writeFileSync(join(repo,'package-lock.json'),'{}\n');
  writeFileSync(join(repo,'apps/node/vitest.config.ts'),'export default {};\n');
  const commit = () => { git('add','.');git('-c','user.name=Ivan Korol','-c','user.email=invariant0x@icloud.com','commit','-m','Fixture');return git('rev-parse','HEAD'); };
  mkdirSync(join(repo,'scripts'),{recursive:true});writeFileSync(join(repo,'scripts/check-release.mjs'),'// Fixture release check\n');
  const control = commit();mkdirSync(join(repo,'apps/node/test'),{recursive:true});writeFileSync(join(repo,'apps/node/test/optimized.ts'),'// clock optimization\n');
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
if(tool==='npx'||(tool==='npm'&&args[0]==='test')) {
 const pkg=cwd.endsWith('protocol')||args.includes('@hornhoof/protocol')?'packages/protocol':cwd.slice(cwd.lastIndexOf('apps/'));
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
  return { root, repo, control, optimized, trace:join(root,'trace.jsonl'), env:{...process.env,PATH:bin+':'+process.env.PATH,HH_PAIR_TRACE:join(root,'trace.jsonl')} };
}
function run(f, env={}) {const result=spawnSync(process.execPath,[DRIVER,f.control,f.optimized],{cwd:f.repo,env:{...f.env,...env},encoding:'utf8',timeout:30000,maxBuffer:32*1024*1024});return {...result,records:result.stdout.split('\n').filter(l=>l.startsWith('HH_PAIR_')).map(l=>{const at=l.indexOf(' ');return {kind:l.slice(0,at),...JSON.parse(l.slice(at+1))};})};}
test('runs both pinned commits as eight isolated logical shards with all original stages', t=>{
 const f=fixture(t),r=run(f);assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
 const trace=readFileSync(f.trace,'utf8').trim().split('\n').map(JSON.parse);assert.equal(trace.length,52);
 const installs=trace.filter(x=>x.tool==='npm'&&x.args[0]==='ci');assert.equal(installs.length,8);assert.equal(new Set(installs.map(x=>x.cwd)).size,8);assert.equal(new Set(installs.map(x=>x.cache)).size,8);assert.ok(installs.every(x=>x.cacheWasEmpty));
 const tests=trace.filter(x=>x.tool==='npx');assert.equal(tests.length,24);
 for(const x of tests){assert.equal(x.sha,x.variant==='control'?f.control:f.optimized);assert.equal(x.parts,'4');assert.deepEqual(x.args,['--no-install','vitest','run','--shard='+x.part+'/4','--maxWorkers=2']);}
 const result=r.records.find(x=>x.kind==='HH_PAIR_RESULT');assert.equal(result.valid,true);assert.equal(result.failed,false);assert.deepEqual(result.counts.control,{'packages/protocol':3,'apps/server':12,'apps/node':12,'apps/web':12});assert.deepEqual(result.counts.optimized,result.counts.control);
 assert.ok(r.records.some(x=>x.kind==='HH_PAIR_RESOURCE'));assert.equal(r.records.filter(x=>x.kind==='HH_PAIR_STAGE').length,54);
});
test('retains a failed stage and still records both variants without retries',t=>{
 const f=fixture(t),r=run(f,{HH_PAIR_FIXTURE_FAIL:'1'});assert.equal(r.status,1);assert.match(r.stdout,/FAIL retained fixture error/);
 const result=r.records.find(x=>x.kind==='HH_PAIR_RESULT');assert.equal(result.failed,true);assert.equal(result.failures.length,1);assert.equal(result.failures[0].part,2);assert.equal(result.failures[0].variant,'optimized');
 assert.equal(r.records.filter(x=>x.kind==='HH_PAIR_STAGE').length,54);
});
test('rejects a changed package/config before executing benchmark stages',t=>{
 const f=fixture(t,true),r=run(f);assert.equal(r.status,1);assert.ok(r.records.some(x=>x.kind==='HH_PAIR_INVALID'));assert.equal(r.records.filter(x=>x.kind==='HH_PAIR_STAGE').length,0);
});

test('marks setup failure incomplete rather than validating empty or partial counts',t=>{
 const f=fixture(t),r=run(f,{HH_PAIR_FIXTURE_SETUP_FAIL:'1'});assert.equal(r.status,1);
 const result=r.records.find(x=>x.kind==='HH_PAIR_RESULT');assert.equal(result.complete,false);assert.equal(result.valid,false);assert.equal(result.failed,true);
});
test('samples resources during a child command and archives complete timing evidence at the end',t=>{
 const f=fixture(t),r=run(f,{HH_PAIR_FIXTURE_PAUSE:'1'});assert.equal(r.status,0,r.stderr);
 assert.ok(r.records.some(x=>x.kind==='HH_PAIR_RESOURCE'&&x.point==='during'));
 const rows=decodeEvidence(r.stdout);assert.equal(rows.filter(x=>x.kind==='HH_PAIR_STAGE').length,54);
 assert.equal(rows.filter(x=>x.kind==='HH_PAIR_OUTPUT').length,54);
 assert.ok(rows.some(x=>x.kind==='HH_PAIR_RESOURCE'&&x.value.point==='during'));
 assert.equal(rows.at(-1).kind,'HH_PAIR_RESULT');
});
test('rejects evidence that cannot fit the runner tail instead of silently losing logs',t=>{
 const f=fixture(t),r=run(f,{HH_PAIR_FIXTURE_BUDGET:'1'});assert.equal(r.status,1);
 assert.ok(r.records.some(x=>x.kind==='HH_PAIR_INVALID'&&x.message.includes('tail budget')));
 assert.ok(!r.records.some(x=>x.kind==='HH_PAIR_EVIDENCE'));
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
 assert.equal(r.records.filter(x=>x.kind==='HH_PAIR_STAGE').length,54);
});

function decodeEvidence(output) {
 const line=output.split('\n').findLast(x=>x.startsWith('HH_PAIR_EVIDENCE '));assert.ok(line,'compressed evidence must be present');
 const frame=JSON.parse(line.slice('HH_PAIR_EVIDENCE '.length));assert.ok(Buffer.byteLength(line+'\n')<=700*1024,'archive must fit the runner tail budget');
 const bytes=Buffer.from(frame.gzip,'base64');assert.equal(createHash('sha256').update(bytes).digest('hex'),frame.sha256);
 return JSON.parse(gunzipSync(bytes).toString());
}
test('preserves middle failures, every file and resource sample through the actual runner log limit',t=>{
 const f=fixture(t),r=run(f,{HH_PAIR_FIXTURE_VOLUME:'1',HH_PAIR_FIXTURE_PAUSE:'1'});assert.equal(r.status,1);
 const source=readFileSync(new URL('../../apps/node/src/tests.ts',import.meta.url),'utf8');
 const protocol=readFileSync(new URL('../../packages/protocol/src/index.ts',import.meta.url),'utf8');
 const max=Number(protocol.match(/export const TEST_LOG_BYTES = (.*);/)[1].split('*').map(Number).reduce((a,b)=>a*b,1));
 const klass=source.slice(source.indexOf('class Output {'),source.indexOf('\ntype Ended ='));
 const code=ts.transpile(klass+'\nnew Output()', {target:ts.ScriptTarget.ES2022});
 const output=runInNewContext(code,{Buffer,TEST_LOG_BYTES:max});
 const text=r.stdout;assert.ok(Buffer.byteLength(text)>4*1024*1024);
 for(let i=0;i<text.length;i+=8192) output.add(Buffer.from(text.slice(i,i+8192)));
 const bounded=output.text();assert.match(bounded,/bytes left out/);assert.ok(Buffer.byteLength(bounded)<max+1024);
 const rows=decodeEvidence(bounded);
 assert.equal(rows.filter(x=>x.kind==='HH_PAIR_STAGE').length,54);
 assert.equal(rows.filter(x=>x.kind==='HH_PAIR_TIMING'&&x.value.kind==='file').length,26*121);
 assert.deepEqual(rows.filter(x=>x.kind==='HH_PAIR_RESOURCE'),r.records.filter(x=>x.kind==='HH_PAIR_RESOURCE').map(({kind,...value})=>({kind,value})));
 assert.ok(rows.some(x=>x.kind==='HH_PAIR_FAILED_OUTPUT'&&x.value.output.includes('FAIL middle-stage diagnostic marker')));
 assert.equal(rows.at(-1).value.failed,true);
});
