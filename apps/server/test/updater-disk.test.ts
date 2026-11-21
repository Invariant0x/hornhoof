import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JQ, PARTS, SCRIPT, SQL, runUpdaterStep, stand, startLoop } from './updater-fixture.js';
import { until } from './helpers-basic.js';

const APP = 'ghcr.io/invariant0x/hornhoof';
const NODE = `${APP}-node`;
const UPDATER = `${APP}-updater`;
const NOW = Math.floor(Date.parse('2026-11-21T12:00:00Z') / 1000);
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

type StubImage = { Id: string; Created: string; Size: number; RepoTags: string[] | null; RepoDigests: string[] | null };
type StubContainer = {
  Id: string;
  Name: string;
  Image: string;
  Created: string;
  SizeRw: number;
  State: { Running: boolean; Status: string };
  Config: { Labels: Record<string, string> };
  Mounts: { Type: string; Name?: string }[];
};
type StubVolume = { Name: string; CreatedAt: string; Labels: Record<string, string>; Size: string };
type StubNetwork = { Id: string; Labels: Record<string, string> };
type StubState = {
  images: StubImage[];
  containers: StubContainer[];
  volumes: StubVolume[];
  networks: StubNetwork[];
  buildCacheSize: string;
  reclaimOnPrune: string;
  buildCacheAfterPrune?: string;
  diskTotalKb: number;
  diskFreeKb: number;
  failRmi?: string[];
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/* A self-contained docker + df + date stub that mutates a JSON state file so every removal and measurement is observed directly. */
function dockerWorld(initial: StubState) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-updater-disk-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  const delivered = join(dir, 'delivered');
  const stateFile = join(dir, 'docker-state.json');
  const logFile = join(dir, 'docker.log');
  const clockFile = join(dir, 'now');
  mkdirSync(bin);
  mkdirSync(delivered);
  writeFileSync(stateFile, JSON.stringify(initial));
  writeFileSync(logFile, '');
  writeFileSync(clockFile, String(NOW));

  const dockerStub = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const stateFile = process.env.DISK_STUB_STATE;
const logFile = process.env.DISK_STUB_LOG;
const delivered = process.env.DISK_STUB_DELIVERED;
const args = process.argv.slice(2);
fs.appendFileSync(logFile, 'docker ' + args.join(' ') + '\\n');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));

const filtersOf = (list) => {
  const out = [];
  for (let i = 0; i < list.length; i++) if (list[i] === '--filter' && list[i + 1]) out.push(list[++i]);
  return out;
};
const matchesLabel = (labels, expr) => {
  const eq = expr.indexOf('=');
  if (eq < 0) return Object.prototype.hasOwnProperty.call(labels || {}, expr);
  return (labels || {})[expr.slice(0, eq)] === expr.slice(eq + 1);
};
const filterBy = (items, filters, isContainer = false) => items.filter(item => filters.every(f => {
  if (f.startsWith('label=')) return matchesLabel(isContainer ? item.Config.Labels : item.Labels, f.slice(6));
  if (f.startsWith('status=')) return item.State.Status === f.slice(7);
  return true;
}));

if (args[0] === 'image' && args[1] === 'ls') {
  process.stdout.write(state.images.map(i => i.Id).join('\\n') + (state.images.length ? '\\n' : ''));
  process.exit(0);
}
if (args[0] === 'image' && args[1] === 'inspect') {
  const ids = args.slice(2).filter((a, i, arr) => a !== '--format' && arr[i - 1] !== '--format');
  for (const id of ids) {
    const img = state.images.find(x => x.Id === id);
    if (img) process.stdout.write(JSON.stringify(img) + '\\n');
  }
  process.exit(0);
}
if (args[0] === 'rmi') {
  const force = args.includes('-f') || args.includes('--force');
  const refs = args.slice(1).filter(a => !a.startsWith('-'));
  let failed = false;
  for (const ref of refs) {
    const idx = state.images.findIndex(i => i.Id === ref || (i.RepoTags || []).includes(ref) || (i.RepoDigests || []).includes(ref));
    if (idx < 0) { failed = true; continue; }
    const img = state.images[idx];
    if ((state.failRmi || []).includes(img.Id)) { failed = true; continue; }
    const inUse = state.containers.some(c => c.Image === img.Id);
    if (inUse && !force) { failed = true; continue; }
    if ((img.RepoTags || []).includes(ref) && img.RepoTags.length > 1) {
      img.RepoTags = img.RepoTags.filter(t => t !== ref);
    } else {
      state.images.splice(idx, 1);
    }
  }
  save();
  process.exit(failed ? 1 : 0);
}
if (args[0] === 'ps') {
  const filters = filtersOf(args);
  const all = args.includes('-a') || args.includes('-aq');
  const list = filterBy(all ? state.containers : state.containers.filter(c => c.State.Running), filters, true);
  process.stdout.write(list.map(c => c.Id).join('\\n') + (list.length ? '\\n' : ''));
  process.exit(0);
}
if (args[0] === 'inspect') {
  const ids = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--format') { i++; continue; }
    if (args[i].startsWith('-')) continue;
    ids.push(args[i]);
  }
  for (const id of ids) {
    const c = state.containers.find(x => x.Id === id || x.Name === id);
    if (c) process.stdout.write(JSON.stringify(c) + '\\n');
  }
  process.exit(0);
}
if (args[0] === 'rm') {
  const ids = args.slice(1).filter(a => !a.startsWith('-'));
  state.containers = state.containers.filter(c => !ids.includes(c.Id) && !ids.includes(c.Name));
  save();
  process.exit(0);
}
if (args[0] === 'volume' && args[1] === 'ls') {
  const list = filterBy(state.volumes, filtersOf(args), false);
  process.stdout.write(list.map(v => v.Name).join('\\n') + (list.length ? '\\n' : ''));
  process.exit(0);
}
if (args[0] === 'volume' && args[1] === 'inspect') {
  const names = args.slice(2).filter((a, i, arr) => a !== '--format' && arr[i - 1] !== '--format');
  for (const name of names) {
    const v = state.volumes.find(x => x.Name === name);
    if (v) process.stdout.write(JSON.stringify({ Name: v.Name, CreatedAt: v.CreatedAt, Labels: v.Labels }) + '\\n');
  }
  process.exit(0);
}
if (args[0] === 'volume' && args[1] === 'rm') {
  const names = args.slice(2).filter(a => !a.startsWith('-'));
  state.volumes = state.volumes.filter(v => !names.includes(v.Name));
  save();
  process.exit(0);
}
if (args[0] === 'network' && args[1] === 'ls') {
  const list = filterBy(state.networks, filtersOf(args), false);
  process.stdout.write(list.map(n => n.Id).join('\\n') + (list.length ? '\\n' : ''));
  process.exit(0);
}
if (args[0] === 'network' && args[1] === 'rm') {
  const ids = args.slice(2).filter(a => !a.startsWith('-'));
  state.networks = state.networks.filter(n => !ids.includes(n.Id));
  save();
  process.exit(0);
}
if (args[0] === 'system' && args[1] === 'df') {
  if (args.includes('-v')) {
    process.stdout.write(JSON.stringify({
      Volumes: state.volumes.map(v => ({ Name: v.Name, Size: v.Size })),
      BuildCache: [],
    }) + '\\n');
  } else {
    process.stdout.write(JSON.stringify({ Type: 'Build Cache', Size: state.buildCacheSize, Reclaimable: state.buildCacheSize }) + '\\n');
  }
  process.exit(0);
}
if (args[0] === 'builder' && args[1] === 'prune') {
  const reclaimed = state.reclaimOnPrune || '0B';
  if (state.buildCacheAfterPrune !== undefined) state.buildCacheSize = state.buildCacheAfterPrune;
  save();
  process.stdout.write('Total reclaimed space: ' + reclaimed + '\\n');
  process.exit(0);
}
if (args[0] === 'cp') {
  const src = args[1];
  const dst = args[2];
  const cid = dst.split(':')[0];
  fs.copyFileSync(src, path.join(delivered, cid + '.json'));
  process.exit(0);
}
if (args[0] === 'compose' && args[1] === 'ps') {
  if (args.includes('node')) {
    const node = state.containers.find(c => c.Config.Labels['com.docker.compose.service'] === 'node');
    if (node) process.stdout.write(node.Id + '\\n');
  }
  process.exit(0);
}
process.exit(0);
`;
  writeFileSync(join(bin, 'docker'), dockerStub, { mode: 0o755 });
  chmodSync(join(bin, 'docker'), 0o755);

  const dfStub = `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.DISK_STUB_STATE, 'utf8'));
const total = state.diskTotalKb;
const avail = state.diskFreeKb;
const used = Math.max(0, total - avail);
process.stdout.write('Filesystem 1024-blocks Used Available Capacity Mounted on\\n');
process.stdout.write('/dev/stub ' + total + ' ' + used + ' ' + avail + ' 50% /\\n');
`;
  writeFileSync(join(bin, 'df'), dfStub, { mode: 0o755 });
  chmodSync(join(bin, 'df'), 0o755);

  const dateStub = `#!/bin/sh
if [ "$1" = +%s ]; then
  cat "$DISK_STUB_CLOCK"
  echo
elif [ "$1" = -u ] && [ "$2" = +%Y-%m-%dT%H:%M:%SZ ]; then
  "${process.execPath}" -e 'console.log(new Date(Number(require("node:fs").readFileSync(process.env.DISK_STUB_CLOCK,"utf8").trim())*1000).toISOString().replace(/\\.000Z$/,"Z"))'
else
  exec /bin/date "$@"
fi
`;
  writeFileSync(join(bin, 'date'), dateStub, { mode: 0o755 });
  chmodSync(join(bin, 'date'), 0o755);

  const state = () => JSON.parse(readFileSync(stateFile, 'utf8')) as StubState;
  const calls = () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
  const setClock = (sec: number) => writeFileSync(clockFile, String(sec));
  const readDelivered = (cid: string) => JSON.parse(readFileSync(join(delivered, `${cid}.json`), 'utf8')) as {
    at: string;
    parts: Record<string, number>;
    cleaned: { part: string; bytes: number; at: string }[];
  };
  const jqDir = JQ ? `${dirname(JQ)}:` : '';
  const env = (extra: Record<string, string> = {}) => ({
    PATH: `${bin}:${jqDir}${process.env.PATH ?? '/usr/bin:/bin'}`,
    DISK_STUB_STATE: stateFile,
    DISK_STUB_LOG: logFile,
    DISK_STUB_DELIVERED: delivered,
    DISK_STUB_CLOCK: clockFile,
    HORNHOOF_DISK_STATE: join(dir, 'cleaned-state.json'),
    HORNHOOF_DISK_EVERY: '0',
    ...extra,
  });
  return { dir, delivered, state, calls, setClock, readDelivered, env };
}

const iso = (offsetSec: number) => new Date((NOW + offsetSec) * 1000).toISOString();

describe('updater, Docker disk care', () => {
  beforeAll(() => {
    if (!JQ) throw new Error('The updater tests need jq.');
  });

  it('removes old Hornhoof images without -f while keeping the two newest per repo, any image in use, and non-Hornhoof images', async () => {
    const s = stand();
    const w = dockerWorld({
      images: [
        { Id: 'sha256:app4', Created: iso(-100), Size: 400 * MIB, RepoTags: [`${APP}:0.40.4`], RepoDigests: [`${APP}@sha256:${'4'.repeat(64)}`] },
        { Id: 'sha256:app3', Created: iso(-200), Size: 380 * MIB, RepoTags: [`${APP}:0.40.3`], RepoDigests: [`${APP}@sha256:${'3'.repeat(64)}`] },
        { Id: 'sha256:app2', Created: iso(-300), Size: 360 * MIB, RepoTags: [`${APP}:0.40.2`], RepoDigests: [`${APP}@sha256:${'2'.repeat(64)}`] },
        { Id: 'sha256:app1', Created: iso(-400), Size: 350 * MIB, RepoTags: null, RepoDigests: [`${APP}@sha256:${'1'.repeat(64)}`] },
        { Id: 'sha256:node3', Created: iso(-100), Size: 500 * MIB, RepoTags: [`${NODE}:0.40.4`], RepoDigests: [`${NODE}@sha256:${'a'.repeat(64)}`] },
        { Id: 'sha256:node2', Created: iso(-200), Size: 500 * MIB, RepoTags: [`${NODE}:0.40.3`], RepoDigests: [`${NODE}@sha256:${'b'.repeat(64)}`] },
        { Id: 'sha256:node1', Created: iso(-300), Size: 450 * MIB, RepoTags: [`${NODE}:0.40.2`], RepoDigests: [`${NODE}@sha256:${'c'.repeat(64)}`] },
        { Id: 'sha256:other', Created: iso(-9999), Size: 900 * MIB, RepoTags: ['postgres:17'], RepoDigests: ['postgres@sha256:0000'] },
      ],
      containers: [
        { Id: 'c-app', Name: '/hh-app', Image: 'sha256:app4', Created: iso(-100), SizeRw: 10 * MIB, State: { Running: true, Status: 'running' }, Config: { Labels: { 'com.docker.compose.project': 'srv', 'com.docker.compose.service': 'app' } }, Mounts: [] },
        { Id: 'c-stopped-old', Name: '/hh-old', Image: 'sha256:app2', Created: iso(-300), SizeRw: 5 * MIB, State: { Running: false, Status: 'exited' }, Config: { Labels: { 'com.docker.compose.project': 'srv', 'com.docker.compose.service': 'migrate' } }, Mounts: [] },
        { Id: 'c-node', Name: '/hh-node', Image: 'sha256:node3', Created: iso(-100), SizeRw: 20 * MIB, State: { Running: true, Status: 'running' }, Config: { Labels: { 'com.docker.compose.project': 'srv', 'com.docker.compose.service': 'node' } }, Mounts: [] },
      ],
      volumes: [],
      networks: [],
      buildCacheSize: '100MB',
      reclaimOnPrune: '0B',
      diskTotalKb: 100 * 1024 * 1024,
      diskFreeKb: 50 * 1024 * 1024,
    });

    const r = await runUpdaterStep(s, 'disk_care', w.env());
    expect(r.code).toBe(0);
    expect(w.state().images.map(i => i.Id).sort()).toEqual(['sha256:app2', 'sha256:app3', 'sha256:app4', 'sha256:node2', 'sha256:node3', 'sha256:other']);
    expect(w.calls().filter(c => c.startsWith('docker rmi'))).toEqual(['docker rmi sha256:app1', 'docker rmi sha256:node1']);
    const report = w.readDelivered('c-node');
    expect(report.parts.images).toBe((400 + 380 + 360 + 500 + 500) * MIB);
    expect(report.cleaned).toEqual([{ part: 'images', bytes: (350 + 450) * MIB, at: new Date(NOW * 1000).toISOString().replace('.000Z', 'Z') }]);
    expect(r.out).toContain('Removed old Hornhoof image sha256:app1');

    /* An image whose rmi fails (e.g. a container started on it meanwhile) is not counted as freed, and multi-tagged Hornhoof images untag cleanly without -f. */
    const s2 = stand();
    const wFail = dockerWorld({
      images: [
        { Id: 'sha256:u4', Created: iso(-100), Size: 200 * MIB, RepoTags: [`${UPDATER}:0.40.4`], RepoDigests: null },
        { Id: 'sha256:u3', Created: iso(-200), Size: 200 * MIB, RepoTags: [`${UPDATER}:0.40.3`], RepoDigests: null },
        { Id: 'sha256:u2', Created: iso(-300), Size: 180 * MIB, RepoTags: [`${UPDATER}:0.40.2`, `${UPDATER}:prev`], RepoDigests: null },
        { Id: 'sha256:u1', Created: iso(-400), Size: 170 * MIB, RepoTags: [`${UPDATER}:0.40.1`], RepoDigests: null },
      ],
      containers: [
        { Id: 'c-node', Name: '/hh-node', Image: 'sha256:n', Created: iso(-100), SizeRw: 0, State: { Running: true, Status: 'running' }, Config: { Labels: { 'hornhoof.subscription': 'p1' } }, Mounts: [] },
      ],
      volumes: [],
      networks: [],
      buildCacheSize: '0B',
      reclaimOnPrune: '0B',
      diskTotalKb: 100 * 1024 * 1024,
      diskFreeKb: 50 * 1024 * 1024,
      failRmi: ['sha256:u1'],
    });
    expect((await runUpdaterStep(s2, 'disk_care', wFail.env())).code).toBe(0);
    expect(wFail.state().images.map(i => i.Id).sort()).toEqual(['sha256:u1', 'sha256:u3', 'sha256:u4']);
    expect(wFail.calls().some(c => c.includes(' -f '))).toBe(false);
    expect(wFail.readDelivered('c-node').cleaned).toEqual([{ part: 'images', bytes: 180 * MIB, at: expect.any(String) }]);
  });

  it('removes day-old test stand labs whole while keeping fresh labs, node volumes, and non-Hornhoof containers and volumes', async () => {
    const s = stand();
    const w = dockerWorld({
      images: [],
      containers: [
        { Id: 'c-old-lab', Name: '/hh-lab-old-m1', Image: 'sha256:m', Created: iso(-90_000), SizeRw: 50 * MIB, State: { Running: true, Status: 'running' }, Config: { Labels: { 'hornhoof.lab': 'old-lab' } }, Mounts: [{ Type: 'volume', Name: 'hh-lab-old-m1-docker' }] },
        { Id: 'c-fresh-lab', Name: '/hh-lab-new-m1', Image: 'sha256:m', Created: iso(-3600), SizeRw: 30 * MIB, State: { Running: true, Status: 'running' }, Config: { Labels: { 'hornhoof.lab': 'fresh-lab' } }, Mounts: [{ Type: 'volume', Name: 'hh-lab-new-m1-docker' }] },
        { Id: 'c-sub-node', Name: '/hornhoof-sub-1', Image: 'sha256:n', Created: iso(-200_000), SizeRw: 10 * MIB, State: { Running: true, Status: 'running' }, Config: { Labels: { 'hornhoof.subscription': 'sub-1' } }, Mounts: [{ Type: 'volume', Name: 'hornhoof-sub-1' }] },
        { Id: 'c-foreign', Name: '/my-app', Image: 'sha256:f', Created: iso(-200_000), SizeRw: 99 * MIB, State: { Running: false, Status: 'exited' }, Config: { Labels: {} }, Mounts: [{ Type: 'volume', Name: 'my-data' }] },
      ],
      volumes: [
        { Name: 'hh-lab-old-m1-docker', CreatedAt: iso(-90_000), Labels: { 'hornhoof.lab': 'old-lab' }, Size: '2GiB' },
        { Name: 'hh-lab-new-m1-docker', CreatedAt: iso(-3600), Labels: { 'hornhoof.lab': 'fresh-lab' }, Size: '1GiB' },
        { Name: 'hornhoof-sub-1', CreatedAt: iso(-200_000), Labels: {}, Size: '5GiB' },
        { Name: 'my-data', CreatedAt: iso(-200_000), Labels: {}, Size: '9GiB' },
      ],
      networks: [
        { Id: 'net-old', Labels: { 'hornhoof.lab': 'old-lab' } },
        { Id: 'net-fresh', Labels: { 'hornhoof.lab': 'fresh-lab' } },
        { Id: 'net-foreign', Labels: {} },
      ],
      buildCacheSize: '0B',
      reclaimOnPrune: '0B',
      diskTotalKb: 100 * 1024 * 1024,
      diskFreeKb: 50 * 1024 * 1024,
    });

    const r = await runUpdaterStep(s, 'disk_care', w.env());
    expect(r.code).toBe(0);
    expect(w.state().containers.map(c => c.Id).sort()).toEqual(['c-foreign', 'c-fresh-lab', 'c-sub-node']);
    expect(w.state().volumes.map(v => v.Name).sort()).toEqual(['hh-lab-new-m1-docker', 'hornhoof-sub-1', 'my-data']);
    expect(w.state().networks.map(n => n.Id).sort()).toEqual(['net-foreign', 'net-fresh']);
    const report = w.readDelivered('c-sub-node');
    expect(report.parts.containers).toBe(40 * MIB);
    expect(report.parts.volumes).toBe(6 * GIB);
    expect(report.cleaned).toEqual(
      expect.arrayContaining([
        { part: 'containers', bytes: 50 * MIB, at: expect.any(String) },
        { part: 'volumes', bytes: 2 * GIB, at: expect.any(String) },
      ]),
    );
    expect(existsSync(join(w.delivered, 'c-foreign.json'))).toBe(false);

    /* An orphaned day-old lab volume (with no container left) still goes, while a lab with any fresh volume stays whole. */
    const sOrphan = stand();
    const wOrphan = dockerWorld({
      images: [],
      containers: [
        { Id: 'c-mixed-old', Name: '/hh-lab-mixed-m1', Image: 'sha256:m', Created: iso(-90_000), SizeRw: 10 * MIB, State: { Running: false, Status: 'exited' }, Config: { Labels: { 'hornhoof.lab': 'mixed-lab' } }, Mounts: [] },
        { Id: 'c-lock-old', Name: '/hh-port-lock', Image: 'sha256:a', Created: iso(-90_000), SizeRw: 1 * MIB, State: { Running: false, Status: 'exited' }, Config: { Labels: { 'io.hornhoof.since': String(NOW - 90_000) } }, Mounts: [] },
        { Id: 'c-node', Name: '/hh-node', Image: 'sha256:n', Created: iso(-100), SizeRw: 0, State: { Running: true, Status: 'running' }, Config: { Labels: { 'hornhoof.subscription': 'p1' } }, Mounts: [] },
      ],
      volumes: [
        { Name: 'hh-lab-orphan-vol', CreatedAt: iso(-90_000), Labels: { 'hornhoof.lab': 'orphan-lab' }, Size: '500MiB' },
        { Name: 'hh-lab-mixed-fresh', CreatedAt: iso(-1200), Labels: { 'hornhoof.lab': 'mixed-lab' }, Size: '300MiB' },
      ],
      networks: [{ Id: 'net-orphan', Labels: { 'hornhoof.lab': 'orphan-lab' } }],
      buildCacheSize: '0B',
      reclaimOnPrune: '0B',
      diskTotalKb: 100 * 1024 * 1024,
      diskFreeKb: 50 * 1024 * 1024,
    });
    expect((await runUpdaterStep(sOrphan, 'disk_care', wOrphan.env())).code).toBe(0);
    expect(wOrphan.state().containers.map(c => c.Id).sort()).toEqual(['c-mixed-old', 'c-node']);
    expect(wOrphan.state().volumes.map(v => v.Name)).toEqual(['hh-lab-mixed-fresh']);
    expect(wOrphan.state().networks).toEqual([]);
  });

  it('prunes build cache with until=72h only when cache is over its limit or Docker disk is below threshold', async () => {
    const base = {
      images: [],
      containers: [
        { Id: 'c-node', Name: '/hh-node', Image: 'sha256:n', Created: iso(-100), SizeRw: 0, State: { Running: true, Status: 'running' }, Config: { Labels: { 'hornhoof.subscription': 'p1' } }, Mounts: [] },
      ],
      volumes: [],
      networks: [],
      reclaimOnPrune: '4GiB',
      buildCacheAfterPrune: '2GiB',
    };

    /* Under both thresholds: no prune. */
    const ok = dockerWorld({ ...base, buildCacheSize: '5GiB', diskTotalKb: 100 * 1024 * 1024, diskFreeKb: 50 * 1024 * 1024 });
    expect((await runUpdaterStep(stand(), 'disk_care', ok.env())).code).toBe(0);
    expect(ok.calls().some(c => c.startsWith('docker builder prune'))).toBe(false);
    expect(ok.readDelivered('c-node').parts.buildCache).toBe(5 * GIB);

    /* Cache over max(10% of 100 GiB, 10 GiB) = 10 GiB: prunes unused for 72h. */
    const bigCache = dockerWorld({ ...base, buildCacheSize: '12GiB', diskTotalKb: 100 * 1024 * 1024, diskFreeKb: 50 * 1024 * 1024 });
    expect((await runUpdaterStep(stand(), 'disk_care', bigCache.env())).code).toBe(0);
    expect(bigCache.calls()).toContain('docker builder prune -f --filter until=72h');
    expect(bigCache.readDelivered('c-node').parts.buildCache).toBe(2 * GIB);
    expect(bigCache.readDelivered('c-node').cleaned).toEqual([{ part: 'buildCache', bytes: 4 * GIB, at: expect.any(String) }]);

    /* Disk below threshold (15 GiB < max(10%, 20 GiB)): prunes even though cache is 6 GiB. */
    const lowDisk = dockerWorld({ ...base, buildCacheSize: '6GiB', diskTotalKb: 100 * 1024 * 1024, diskFreeKb: 15 * 1024 * 1024 });
    expect((await runUpdaterStep(stand(), 'disk_care', lowDisk.env())).code).toBe(0);
    expect(lowDisk.calls()).toContain('docker builder prune -f --filter until=72h');
  });

  it('paces passes to at most once an hour and skips while an update is active', async () => {
    const s = stand();
    const w = dockerWorld({
      images: [],
      containers: [
        { Id: 'c-node', Name: '/hh-node', Image: 'sha256:n', Created: iso(-100), SizeRw: 0, State: { Running: true, Status: 'running' }, Config: { Labels: { 'hornhoof.subscription': 'p1' } }, Mounts: [] },
      ],
      volumes: [],
      networks: [],
      buildCacheSize: '0B',
      reclaimOnPrune: '0B',
      diskTotalKb: 100 * 1024 * 1024,
      diskFreeKb: 50 * 1024 * 1024,
    });

    /* Two calls within an hour look at Docker once; with HORNHOOF_DISK_EVERY=0 they look twice. */
    expect((await runUpdaterStep(s, 'disk_care; disk_care', w.env({ HORNHOOF_DISK_EVERY: '3600' }))).code).toBe(0);
    expect(w.calls().filter(c => c.startsWith('docker cp '))).toHaveLength(1);

    expect((await runUpdaterStep(s, 'disk_care; disk_care', w.env({ HORNHOOF_DISK_EVERY: '0' }))).code).toBe(0);
    expect(w.calls().filter(c => c.startsWith('docker cp '))).toHaveLength(3);

    /* Skips while an update is running. */
    const busy = stand();
    writeFileSync(join(busy.control, 'status.json'), JSON.stringify({ id: 'u1', state: 'running', step: 'install' }));
    const w2 = dockerWorld({
      images: [],
      containers: [],
      volumes: [],
      networks: [],
      buildCacheSize: '0B',
      reclaimOnPrune: '0B',
      diskTotalKb: 100 * 1024 * 1024,
      diskFreeKb: 50 * 1024 * 1024,
    });
    expect((await runUpdaterStep(busy, 'disk_care', w2.env())).code).toBe(0);
    expect(w2.calls()).toEqual([]);

    /* Wired into updater.sh's loop. */
    const loopStand = stand();
    const w3 = dockerWorld({
      images: [],
      containers: [
        { Id: 'c-node', Name: '/hh-node', Image: 'sha256:n', Created: iso(-100), SizeRw: 0, State: { Running: true, Status: 'running' }, Config: { Labels: { 'hornhoof.subscription': 'p1' } }, Mounts: [] },
      ],
      volumes: [],
      networks: [],
      buildCacheSize: '1GiB',
      reclaimOnPrune: '0B',
      diskTotalKb: 100 * 1024 * 1024,
      diskFreeKb: 50 * 1024 * 1024,
    });
    startLoop(loopStand, w3.env({ HORNHOOF_DISK_EVERY: '3600', HORNHOOF_SQL_DIR: SQL }));
    await until(() => existsSync(join(w3.delivered, 'c-node.json')));
    expect(w3.readDelivered('c-node').parts.buildCache).toBe(1 * GIB);
  });

  it('keeps a rolling 24-hour cleaned history across passes, newest first', async () => {
    const s = stand();
    const w = dockerWorld({
      images: [
        { Id: 'sha256:app3', Created: iso(-100), Size: 300 * MIB, RepoTags: [`${APP}:0.40.3`], RepoDigests: null },
        { Id: 'sha256:app2', Created: iso(-200), Size: 300 * MIB, RepoTags: [`${APP}:0.40.2`], RepoDigests: null },
        { Id: 'sha256:app1', Created: iso(-300), Size: 100 * MIB, RepoTags: [`${APP}:0.40.1`], RepoDigests: null },
      ],
      containers: [
        { Id: 'c-node', Name: '/hh-node', Image: 'sha256:n', Created: iso(-100), SizeRw: 0, State: { Running: true, Status: 'running' }, Config: { Labels: { 'hornhoof.subscription': 'p1' } }, Mounts: [] },
      ],
      volumes: [],
      networks: [],
      buildCacheSize: '0B',
      reclaimOnPrune: '0B',
      diskTotalKb: 100 * 1024 * 1024,
      diskFreeKb: 50 * 1024 * 1024,
    });
    w.setClock(NOW - 25 * 3600);
    expect((await runUpdaterStep(s, 'disk_care', w.env())).code).toBe(0);
    expect(w.readDelivered('c-node').cleaned).toHaveLength(1);

    /* 23 hours later: another removal keeps both, newest first. */
    const next = w.state();
    next.images.push({ Id: 'sha256:app0', Created: iso(-400), Size: 200 * MIB, RepoTags: [`${APP}:0.40.0`], RepoDigests: null });
    writeFileSync(join(w.dir, 'docker-state.json'), JSON.stringify(next));
    w.setClock(NOW - 2 * 3600);
    expect((await runUpdaterStep(s, 'disk_care', w.env())).code).toBe(0);
    expect(w.readDelivered('c-node').cleaned.map(c => c.bytes)).toEqual([200 * MIB, 100 * MIB]);

    /* 2 hours later (25 hours after the first): the first entry drops off. */
    w.setClock(NOW);
    expect((await runUpdaterStep(s, 'disk_care', w.env())).code).toBe(0);
    expect(w.readDelivered('c-node').cleaned.map(c => c.bytes)).toEqual([200 * MIB]);
  });
});

/* Unused imports guard: keep SCRIPT/PARTS referenced for direct nodes_mode check below. */
describe('updater nodes mode, Docker disk care', () => {
  it('runs disk care in nodes_mode as well', async () => {
    const w = dockerWorld({
      images: [],
      containers: [
        { Id: 'c-node', Name: '/hh-node', Image: 'sha256:n', Created: iso(-100), SizeRw: 0, State: { Running: true, Status: 'running' }, Config: { Labels: { 'hornhoof.subscription': 'p1' } }, Mounts: [] },
      ],
      volumes: [],
      networks: [],
      buildCacheSize: '2GiB',
      reclaimOnPrune: '0B',
      diskTotalKb: 100 * 1024 * 1024,
      diskFreeKb: 50 * 1024 * 1024,
    });
    const child = spawn('bash', ['-euo', 'pipefail', '-c', `. "${PARTS}shared.sh"; . "${PARTS}state.sh"; . "${PARTS}server.sh"; . "${PARTS}nodes.sh"; . "${PARTS}disk.sh"; disk_care`], {
      env: { ...process.env, ...w.env(), HORNHOOF_IMAGE: APP, IMAGE: APP, NODE_IMAGE: NODE, UPDATER_IMAGE: UPDATER, CONTROL: join(w.dir, 'no-control'), SERVER_DIR: '' },
    });
    const [code] = (await once(child, 'exit')) as [number | null];
    expect(code).toBe(0);
    expect(w.readDelivered('c-node').parts.buildCache).toBe(2 * GIB);
    expect(existsSync(SCRIPT)).toBe(true);
  });
});
