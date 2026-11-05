import console from 'node:console';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { setInterval, clearInterval } from 'node:timers';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { availableParallelism, arch, cpus, freemem, hostname, loadavg, platform, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';

const root = process.cwd();
const archive = [];
const emit = (kind, value) => {
  console.log(kind + ' ' + JSON.stringify(value));
  archive.push({ kind, value });
};
function replay() {
  const bytes=gzipSync(JSON.stringify(archive));
  const line='HH_PAIR_EVIDENCE '+JSON.stringify({sha256:createHash('sha256').update(bytes).digest('hex'),gzip:bytes.toString('base64')});
  if(Buffer.byteLength(line+'\n')>700*1024) throw new Error('Complete evidence exceeds the 700 KiB runner tail budget');
  console.log(line);
}
const read = path => { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } };
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const limit = (v2, v1) => read('/sys/fs/cgroup/' + v2) ?? read('/sys/fs/cgroup/' + v1);
function identity() {
  return { platform: platform(), release: release(), arch: arch(), node: process.version, host: hostname(), cpus: availableParallelism(), hostCpus: cpus().length, model: cpus()[0]?.model,
    cpuMax: limit('cpu.max','cpu/cpu.cfs_quota_us'), cpuPeriod: limit('cpu.max','cpu/cpu.cfs_period_us'), cpuset: limit('cpuset.cpus.effective','cpuset/cpuset.cpus'), memoryMax: limit('memory.max','memory/memory.limit_in_bytes') };
}
function resource(context, point) {
  const mem = read('/proc/meminfo');
  const value = { ...context, point, at: new Date().toISOString(), load: loadavg(), free: freemem(), total: totalmem(), availableKb: mem?.match(/^MemAvailable:\s+(\d+)/m)?.[1] ?? null,
    limits: identity(), cpuStat: read('/sys/fs/cgroup/cpu.stat'), cpuPressure: read('/sys/fs/cgroup/cpu.pressure'), memoryCurrent: read('/sys/fs/cgroup/memory.current'), memoryEvents: read('/sys/fs/cgroup/memory.events'), memoryPressure: read('/sys/fs/cgroup/memory.pressure') };
  emit('HH_PAIR_RESOURCE', value);return value;
}
const configPaths = ['package.json','package-lock.json','apps/server/vitest.config.ts','apps/node/vitest.config.ts','apps/web/vite.config.ts','packages/protocol/vitest.config.ts','apps/server/test/global-setup.ts','apps/server/test/helpers.ts'];
function configHash(dir) {
  return Object.fromEntries(configPaths.map(path => [path, existsSync(join(dir,path)) ? createHash('sha256').update(readFileSync(join(dir,path))).digest('hex') : null]));
}
function pinned(control, optimized) {
  for (const sha of [control, optimized]) assert.match(sha ?? '',/^[0-9a-f]{40}$/,'Two full pinned commit SHAs are required');
  git('merge-base','--is-ancestor',control,optimized);
  assert.equal(platform(),'linux','Linux is required');
  const env = identity();
  assert.ok(env.cpuMax,'Visible CPU quota is unavailable');assert.ok(env.memoryMax,'Visible memory quota is unavailable');
  assert.equal(execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim(),process.execPath,'Node on PATH differs from driver Node');
  return env;
}
function worktrees(control, optimized, scratch) {
  const all = [];
  for (const [variant,sha] of [['control',control],['optimized',optimized]]) for (let part=1;part<=4;part++) {
    const dir = join(scratch,variant+'-'+part), cache = join(scratch,'cache-'+variant+'-'+part);
    if (existsSync(dir) || existsSync(cache)) throw new Error('A fresh paired workspace/cache is required');
    git('worktree','add','--detach',dir,sha);mkdirSync(cache,{recursive:true});
    all.push({variant,sha,part,dir,cache});
  }
  const hashes = configHash(all[0].dir);
  for (const item of all) if (JSON.stringify(configHash(item.dir)) !== JSON.stringify(hashes)) throw new Error('Package lock or shared test configuration differs');
  emit('HH_PAIR_CONFIG',hashes);
  return all;
}
function steps(part) {
  const all = [ ['install',['npm','ci','--prefer-offline','--no-audit','--no-fund']], ['protocol-build',['npm','run','build','-w','@hornhoof/protocol']] ];
  if(part===1) all.push(
    ['lint',['npm','run','lint'],null,{NODE_OPTIONS:'--max-old-space-size=2048'}],
    ['typecheck-tests',['npm','run','typecheck:tests'],null,{NODE_OPTIONS:'--max-old-space-size=2048'}],
    ['release-check',['node','scripts/check-release.mjs','--local']],['release-tests',['npm','run','test:release']],
    ['packages/protocol',['npm','test','-w','@hornhoof/protocol','--','--maxWorkers=2']],['shell-syntax',['bash','-n','scripts/install.sh']],['shellcheck',['shellcheck','scripts/install.sh','scripts/node-build.sh']]);
  for(const pkg of ['apps/server','apps/node','apps/web']) all.push([pkg,['npx','--no-install','vitest','run','--shard='+part+'/4','--maxWorkers=2'],pkg]);
  return all;
}
function child(command, cwd, env, file) {
  return new Promise(resolve => {
    const chunks=[];let error=null;const start=performance.now();
    const proc=spawn(command[0],command.slice(1),{cwd,env,stdio:['ignore','pipe','pipe']});
    for(const stream of [proc.stdout,proc.stderr]) stream.on('data',chunk=>chunks.push(chunk));
    proc.once('error',err=>error=err.message);
    proc.once('close',(code,signal)=>{const ms=performance.now()-start;const output=Buffer.concat(chunks).toString();writeFileSync(file,output);resolve({code:code??1,signal,error,output,ms});});
  });
}
function timings(output, context, counts) {
  const summaries=[];
  for(const line of output.split('\n')) {
    const at=line.indexOf('::hh-test-timing::');if(at<0)continue;
    const timing=JSON.parse(line.slice(at+'::hh-test-timing::'.length));
    if(timing.kind==='package') summaries.push(timing);
    const compact={...timing};delete compact.slowest;
    emit('HH_PAIR_TIMING',{...context,...compact});
  }
  return countSummary(context.stage,summaries,counts);
}
function countSummary(stage, summaries, counts) {
  if(!['packages/protocol','apps/server','apps/node','apps/web'].includes(stage)) return summaries.length===0;
  const summary=summaries[0];
  const valid=summaries.length===1&&summary.package===stage&&Number.isInteger(summary.tests)&&summary.tests>0;
  if(valid) counts[summary.package]=(counts[summary.package]??0)+summary.tests;
  return valid;
}
function stable(expected) {
  const actual=identity();
  if(JSON.stringify(actual)!==JSON.stringify(expected)) throw new Error('Worker identity or resource quotas changed: '+JSON.stringify({expected,actual}));
}
async function stage(item, spec, expected, scratch, counts) {
  const [name,command,relative,extra]=spec;
  const context={variant:item.variant,sha:item.sha,part:item.part,parts:4,stage:name};
  stable(expected);emit('HH_PAIR_COMMAND',{...context,command,cwd:relative??'.',cache:item.cache});
  const samples=[resource(context,'before')];let drift=null;
  const timer=setInterval(()=>{const sample=resource(context,'during');samples.push(sample);if(JSON.stringify(sample.limits)!==JSON.stringify(expected))drift=sample.limits;},5000),start=performance.now();
  let result;
  try {result=await child(command,relative?join(item.dir,relative):item.dir,{...process.env,VITEST_MAX_WORKERS:'2',HH_TEST_PART:String(item.part),HH_TEST_PARTS:'4',HH_PAIR_VARIANT:item.variant,npm_config_cache:item.cache,NPM_CONFIG_CACHE:item.cache,...extra},join(scratch,item.variant+'-'+item.part+'-'+name.replaceAll('/','_')+'.log'));}
  finally {clearInterval(timer);}
  samples.push(resource(context,'after'));stable(expected);
  if(drift)throw new Error('Worker limits changed during stage: '+JSON.stringify(drift));
  const timingValid=timings(result.output,context,counts);
  archive.push({kind:'HH_PAIR_OUTPUT',value:{...context,output:result.output}});
  if(result.code!==0) emit('HH_PAIR_FAILED_OUTPUT',{...context,output:result.output});
  if(result.error)emit('HH_PAIR_CHILD_ERROR',{...context,message:result.error});
  const ranges={samples:samples.length,loadMin:[0,1,2].map(i=>Math.min(...samples.map(s=>s.load[i]))),loadMax:[0,1,2].map(i=>Math.max(...samples.map(s=>s.load[i]))),freeMin:Math.min(...samples.map(s=>s.free)),freeMax:Math.max(...samples.map(s=>s.free))};
  const row={...context,resources:ranges,ms:Math.round(result.ms),collectionMs:Math.round(performance.now()-start-result.ms),timingValid,exitCode:result.code,signal:result.signal};emit('HH_PAIR_STAGE',row);return row;
}
async function compare(control, optimized) {
  const env=pinned(control,optimized),scratch=join(root,'.metrics','paired-tests');mkdirSync(scratch,{recursive:true});
  emit('HH_PAIR_ENV',{...env,control,optimized,mode:'sequential-four-logical-shards-per-variant',cachePolicy:'fresh-worktree-and-empty-npm-cache-per-logical-shard; host page caches not controlled',backgroundLoad:'observed, not controlled'});
  const all=worktrees(control,optimized,scratch),counts={control:{},optimized:{}},failures=[];let executed=0,allTimings=true;
  for(const item of all) {
    emit('HH_PAIR_PART',{variant:item.variant,part:item.part,sha:item.sha});
    for(const spec of steps(item.part)) {
      const row=await stage(item,spec,env,scratch,counts[item.variant]);executed++;allTimings&&=row.timingValid;
      if(row.exitCode!==0) failures.push(row);
      if(row.exitCode!==0 && ['install','protocol-build'].includes(spec[0])) break;
    }
  }
  const result=resultOf(counts,failures,executed===54&&allTimings);
  emit('HH_PAIR_RESULT',result);return result;
}
function resultOf(counts, failures, complete) {
  const equal=JSON.stringify(Object.entries(counts.control).sort())===JSON.stringify(Object.entries(counts.optimized).sort());
  const result={valid:equal&&complete,complete,failed:failures.length>0,failures,counts,identityAndConfig:'verified',backgroundLoad:'review resource records before performance claims'};
  return result;
}
export { identity, resource };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {const result=await compare(process.argv[2],process.argv[3]);process.exitCode=result.failed||!result.valid?1:0;}
  catch(error){emit('HH_PAIR_INVALID',{message:error.message});process.exitCode=1;}
  try {replay();} catch(error) {console.log('HH_PAIR_INVALID '+JSON.stringify({message:error.message}));process.exitCode=1;}
}
