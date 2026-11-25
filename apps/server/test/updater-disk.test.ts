import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
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

type StubImage = {
  Id: string;
  Created: string;
  Size: number;
  RepoTags: string[] | null;
  RepoDigests: string[] | null;
  RootFS?: { Layers: string[] };
};
type StubContainer = {
  Id: string;
  Name: string;
  Image: string;
  Created: string;
  SizeRw: number;
  State: { Running: boolean; Status: string };
  Config: { Labels: Record<string, string>; Env?: string[] };
  Mounts: { Type: string; Name?: string }[];
  GraphDriver?: { Data: Record<string, string> };
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
  failCmd?: string[];
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
const cmd1 = args[0] || '';
const cmd2 = (args[0] || '') + ' ' + (args[1] || '');

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

(() => {
  if ((state.failCmd || []).includes(cmd1) || (state.failCmd || []).includes(cmd2)) { process.exitCode = 1; return; }
  if (args[0] === 'image' && args[1] === 'ls') {
    process.stdout.write(state.images.map(i => i.Id).join('\\n') + (state.images.length ? '\\n' : ''));
    return;
  }
  if (args[0] === 'image' && args[1] === 'inspect') {
    const ids = args.slice(2).filter((a, i, arr) => a !== '--format' && arr[i - 1] !== '--format');
    for (const id of ids) {
      const img = state.images.find(x => x.Id === id);
      if (img) process.stdout.write(JSON.stringify(img) + '\\n');
    }
    return;
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
    process.exitCode = failed ? 1 : 0;
    return;
  }
  if (args[0] === 'ps') {
    const filters = filtersOf(args);
    const all = args.includes('-a') || args.includes('-aq');
    const list = filterBy(all ? state.containers : state.containers.filter(c => c.State.Running), filters, true);
    process.stdout.write(list.map(c => c.Id).join('\\n') + (list.length ? '\\n' : ''));
    return;
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
    return;
  }
  if (args[0] === 'rm') {
    const force = args.includes('-f') || args.includes('--force');
    const ids = args.slice(1).filter(a => !a.startsWith('-'));
    let failed = false;
    for (const id of ids) {
      const idx = state.containers.findIndex(c => c.Id === id || c.Name === id);
      if (idx < 0) { failed = true; continue; }
      if (state.containers[idx].State.Running && !force) { failed = true; continue; }
      state.containers.splice(idx, 1);
    }
    save();
    process.exitCode = failed ? 1 : 0;
    return;
  }
  if (args[0] === 'volume' && args[1] === 'ls') {
    const list = filterBy(state.volumes, filtersOf(args), false);
    process.stdout.write(list.map(v => v.Name).join('\\n') + (list.length ? '\\n' : ''));
    return;
  }
  if (args[0] === 'volume' && args[1] === 'inspect') {
    const names = args.slice(2).filter((a, i, arr) => a !== '--format' && arr[i - 1] !== '--format');
    for (const name of names) {
      const v = state.volumes.find(x => x.Name === name);
      if (v) process.stdout.write(JSON.stringify({ Name: v.Name, CreatedAt: v.CreatedAt, Labels: v.Labels }) + '\\n');
    }
    return;
  }
  if (args[0] === 'volume' && args[1] === 'rm') {
    const names = args.slice(2).filter(a => !a.startsWith('-'));
    state.volumes = state.volumes.filter(v => !names.includes(v.Name));
    save();
    return;
  }
  if (args[0] === 'network' && args[1] === 'ls') {
    const list = filterBy(state.networks, filtersOf(args), false);
    process.stdout.write(list.map(n => n.Id).join('\\n') + (list.length ? '\\n' : ''));
    return;
  }
  if (args[0] === 'network' && args[1] === 'rm') {
    const ids = args.slice(2).filter(a => !a.startsWith('-'));
    state.networks = state.networks.filter(n => !ids.includes(n.Id));
    save();
    return;
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
    return;
  }
  if (args[0] === 'builder' && args[1] === 'prune') {
    const reclaimed = state.reclaimOnPrune || '0B';
    if (state.buildCacheAfterPrune !== undefined) state.buildCacheSize = state.buildCacheAfterPrune;
    save();
    process.stdout.write('Total reclaimed space: ' + reclaimed + '\\n');
    return;
  }
  if (args[0] === 'image' && args[1] === 'prune') {
    if (args.includes('-a') || args.includes('--all')) { process.exitCode = 2; return; }
    let bytes = 0;
    state.images = state.images.filter(img => {
      const tags = (img.RepoTags || []).filter(t => t !== '<none>:<none>');
      const digests = (img.RepoDigests || []).filter(d => d !== '<none>@<none>');
      const inUse = state.containers.some(c => c.Image === img.Id);
      if (tags.length === 0 && digests.length === 0 && !inUse) {
        bytes += img.Size || 0;
        return false;
      }
      return true;
    });
    save();
    process.stdout.write('Total reclaimed space: ' + bytes + 'B\\n');
    return;
  }
  if (args[0] === 'cp') {
    const src = args[1];
    const dst = args[2];
    const cid = dst.split(':')[0];
    const st = fs.statSync(src);
    if (path.basename(src) !== 'docker-disk.json' || dst !== cid + ':/data/') { process.exitCode = 2; return; }
    if ((st.mode & 0o444) !== 0o444) { process.exitCode = 2; return; }
    const target = path.join(delivered, cid + '.json');
    const tmp = target + '.tmp.' + process.pid;
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, target);
    return;
  }
  if (args[0] === 'compose' && args[1] === 'ps') {
    if (args.includes('node')) {
      const node = state.containers.find(c => c.Config.Labels['com.docker.compose.service'] === 'node');
      if (node) process.stdout.write(node.Id + '\\n');
    }
    return;
  }
})();
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
        { Id: 'sha256:shared-digest', Created: iso(-500), Size: 300 * MIB, RepoTags: [`${APP}:0.39.0`], RepoDigests: [`${APP}@sha256:${'9'.repeat(64)}`, `other/repo@sha256:${'8'.repeat(64)}`] },
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
    expect(w.state().images.map(i => i.Id).sort()).toEqual(['sha256:app2', 'sha256:app3', 'sha256:app4', 'sha256:node2', 'sha256:node3', 'sha256:other', 'sha256:shared-digest']);
    expect(w.calls().filter(c => c.startsWith('docker rmi'))).toEqual(['docker rmi sha256:app1', 'docker rmi sha256:node1']);
    const report = w.readDelivered('c-node');
    expect(report.parts.images).toBe((400 + 380 + 360 + 500 + 500 + 300) * MIB);
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

    /* An orphaned day-old lab volume (with no container left) still goes, while a lab with any fresh volume or Go zero timestamp stays whole, and exited lock containers are removed without -f. */
    const sOrphan = stand();
    const wOrphan = dockerWorld({
      images: [],
      containers: [
        { Id: 'c-mixed-old', Name: '/hh-lab-mixed-m1', Image: 'sha256:m', Created: iso(-90_000), SizeRw: 10 * MIB, State: { Running: false, Status: 'exited' }, Config: { Labels: { 'hornhoof.lab': 'mixed-lab' } }, Mounts: [] },
        { Id: 'c-zero-ts', Name: '/hh-lab-zero-m1', Image: 'sha256:m', Created: '0001-01-01T00:00:00Z', SizeRw: 10 * MIB, State: { Running: false, Status: 'exited' }, Config: { Labels: { 'hornhoof.lab': 'zero-lab' } }, Mounts: [] },
        { Id: 'c-lock-old', Name: '/hh-port-lock', Image: 'sha256:a', Created: iso(-90_000), SizeRw: 1 * MIB, State: { Running: false, Status: 'exited' }, Config: { Labels: { 'io.hornhoof.since': String(NOW - 90_000) } }, Mounts: [] },
        { Id: 'c-lock-running', Name: '/hh-port-lock-live', Image: 'sha256:a', Created: iso(-90_000), SizeRw: 1 * MIB, State: { Running: true, Status: 'running' }, Config: { Labels: { 'io.hornhoof.since': String(NOW - 90_000) } }, Mounts: [] },
        { Id: 'c-node', Name: '/hh-node', Image: 'sha256:n', Created: iso(-100), SizeRw: 0, State: { Running: true, Status: 'running' }, Config: { Labels: { 'hornhoof.subscription': 'p1' } }, Mounts: [] },
      ],
      volumes: [
        { Name: 'hh-lab-orphan-vol', CreatedAt: iso(-90_000), Labels: { 'hornhoof.lab': 'orphan-lab' }, Size: '500MiB' },
        { Name: 'hh-lab-mixed-fresh', CreatedAt: iso(-1200), Labels: { 'hornhoof.lab': 'mixed-lab' }, Size: '300MiB' },
        { Name: 'hh-lab-zero-vol', CreatedAt: '0001-01-01T00:00:00Z', Labels: { 'hornhoof.lab': 'zero-lab' }, Size: '300MiB' },
      ],
      networks: [{ Id: 'net-orphan', Labels: { 'hornhoof.lab': 'orphan-lab' } }],
      buildCacheSize: '0B',
      reclaimOnPrune: '0B',
      diskTotalKb: 100 * 1024 * 1024,
      diskFreeKb: 50 * 1024 * 1024,
    });
    expect((await runUpdaterStep(sOrphan, 'disk_care', wOrphan.env())).code).toBe(0);
    expect(wOrphan.state().containers.map(c => c.Id).sort()).toEqual(['c-lock-running', 'c-mixed-old', 'c-node', 'c-zero-ts']);
    expect(wOrphan.state().volumes.map(v => v.Name).sort()).toEqual(['hh-lab-mixed-fresh', 'hh-lab-zero-vol']);
    expect(wOrphan.state().networks).toEqual([]);
    expect(wOrphan.calls()).toContain('docker rm -v c-lock-old');
    expect(wOrphan.calls()).not.toContain('docker rm -f -v c-lock-old');
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

    /* Disk below threshold (15 GB < max(10%, 20 GB)): prunes all unused build cache without holding back recent cache. */
    const lowDisk = dockerWorld({ ...base, buildCacheSize: '6GB', diskTotalKb: 100 * 1_000_000, diskFreeKb: 15 * 1_000_000 });
    expect((await runUpdaterStep(stand(), 'disk_care', lowDisk.env())).code).toBe(0);
    expect(lowDisk.calls()).toContain('docker builder prune -f');
  });

  it('prunes dangling images and build cache on a machine short of space in decimal GB while never touching volumes, tagged images, or stopped containers', async () => {
    const w = dockerWorld({
      images: [
        { Id: 'sha256:app2', Created: iso(-100), Size: 400 * MIB, RepoTags: [`${APP}:0.43.0`], RepoDigests: null },
        { Id: 'sha256:app1', Created: iso(-200), Size: 380 * MIB, RepoTags: [`${APP}:0.42.0`], RepoDigests: null },
        { Id: 'sha256:foreign-tagged', Created: iso(-5000), Size: 900 * MIB, RepoTags: ['postgres:17'], RepoDigests: ['postgres@sha256:1111'] },
        { Id: 'sha256:dangling-unused', Created: iso(-600), Size: 650 * MIB, RepoTags: ['<none>:<none>'], RepoDigests: [] },
        { Id: 'sha256:dangling-stopped-runner', Created: iso(-700), Size: 500 * MIB, RepoTags: [], RepoDigests: [] },
      ],
      containers: [
        { Id: 'c-node', Name: '/hh-node', Image: 'sha256:app2', Created: iso(-100), SizeRw: 10 * MIB, State: { Running: true, Status: 'running' }, Config: { Labels: { 'hornhoof.subscription': 'p1' } }, Mounts: [{ Type: 'volume', Name: 'hh-node-data' }] },
        { Id: 'c-stopped-runner', Name: '/runner-prev', Image: 'sha256:dangling-stopped-runner', Created: iso(-86_400 * 5), SizeRw: 120 * MIB, State: { Running: false, Status: 'exited' }, Config: { Labels: {} }, Mounts: [{ Type: 'volume', Name: 'runner-cache' }] },
      ],
      volumes: [
        { Name: 'hh-node-data', CreatedAt: iso(-200_000), Labels: {}, Size: '66.1GB' },
        { Name: 'runner-cache', CreatedAt: iso(-200_000), Labels: {}, Size: '9GB' },
      ],
      networks: [],
      buildCacheSize: '800MB',
      reclaimOnPrune: '800MB',
      buildCacheAfterPrune: '0B',
      diskTotalKb: Math.floor((126 * 1_000_000_000) / 1024),
      diskFreeKb: Math.floor((18.5 * 1_000_000_000) / 1024),
    });

    expect((await runUpdaterStep(stand(), 'disk_care', w.env())).code).toBe(0);
    expect(w.calls()).toContain('docker image prune -f --filter dangling=true');
    expect(w.calls()).toContain('docker builder prune -f');
    expect(w.calls().some(c => c.startsWith('docker volume rm') || c.startsWith('docker volume prune') || c.startsWith('docker container prune') || c.startsWith('docker system prune'))).toBe(false);
    expect(w.state().images.map(i => i.Id).sort()).toEqual(['sha256:app1', 'sha256:app2', 'sha256:dangling-stopped-runner', 'sha256:foreign-tagged']);
    expect(w.state().containers.map(c => c.Id).sort()).toEqual(['c-node', 'c-stopped-runner']);
    expect(w.state().volumes.map(v => v.Name).sort()).toEqual(['hh-node-data', 'runner-cache']);
    expect(w.readDelivered('c-node').cleaned).toEqual(
      expect.arrayContaining([
        { part: 'images', bytes: 650 * MIB, at: expect.any(String) },
        { part: 'buildCache', bytes: 800_000_000, at: expect.any(String) },
      ]),
    );

    /* 21 GB decimal free on a 126 GB disk is above the 20 GB decimal threshold (even though under 20 GiB = 21.47 GB), so neither dangling-image nor build-cache prune runs. */
    const roomyDecimal = dockerWorld({
      images: [{ Id: 'sha256:dangling-unused', Created: iso(-600), Size: 300 * MIB, RepoTags: ['<none>:<none>'], RepoDigests: [] }],
      containers: [{ Id: 'c-node', Name: '/hh-node', Image: 'sha256:n', Created: iso(-100), SizeRw: 0, State: { Running: true, Status: 'running' }, Config: { Labels: { 'hornhoof.subscription': 'p1' } }, Mounts: [] }],
      volumes: [],
      networks: [],
      buildCacheSize: '800MB',
      reclaimOnPrune: '800MB',
      diskTotalKb: Math.ceil((126 * 1_000_000_000) / 1024),
      diskFreeKb: Math.ceil((21 * 1_000_000_000) / 1024),
    });
    expect((await runUpdaterStep(stand(), 'disk_care', roomyDecimal.env())).code).toBe(0);
    expect(roomyDecimal.calls().some(c => c.startsWith('docker image prune') || c.startsWith('docker builder prune'))).toBe(false);
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

  it('stores cleaned state outside $CONTROL by default and safely resists symlinks, FIFOs, and poisoned state', async () => {
    const emptyWorld = () =>
      dockerWorld({
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

    /* Default with SERVER_DIR set and HORNHOOF_DISK_STATE unset: stays outside $CONTROL and outside $SERVER_DIR/backups. */
    const sDefault = stand();
    const wDefault = emptyWorld();
    expect((await runUpdaterStep(sDefault, 'disk_care', wDefault.env({ HORNHOOF_DISK_STATE: '' }))).code).toBe(0);
    expect(existsSync(join(sDefault.control, 'disk-cleaned.json'))).toBe(false);
    expect(existsSync(join(sDefault.server, 'backups'))).toBe(false);
    const nextDefault = wDefault.state();
    nextDefault.images.push({ Id: 'sha256:app0', Created: iso(-400), Size: 50 * MIB, RepoTags: [`${APP}:0.40.0`], RepoDigests: null });
    writeFileSync(join(wDefault.dir, 'docker-state.json'), JSON.stringify(nextDefault));
    expect((await runUpdaterStep(sDefault, 'disk_care', wDefault.env({ HORNHOOF_DISK_STATE: '' }))).code).toBe(0);
    expect(wDefault.readDelivered('c-node').cleaned.map(c => c.bytes)).toEqual([50 * MIB, 100 * MIB]);

    /* File symlink at $CONTROL/disk-cleaned.json: target file is untouched and symlink is replaced atomically. */
    const sFileLink = stand();
    const wFileLink = emptyWorld();
    const outsideSecret = join(wFileLink.dir, 'secret.env');
    writeFileSync(outsideSecret, 'KEEP_SECRET=1\n');
    const sharedState = join(sFileLink.control, 'disk-cleaned.json');
    symlinkSync(outsideSecret, sharedState);
    const rFileLink = await runUpdaterStep(sFileLink, 'disk_care', wFileLink.env({ HORNHOOF_DISK_STATE: sharedState }));
    expect(rFileLink.code).toBe(0);
    expect(readFileSync(outsideSecret, 'utf8')).toBe('KEEP_SECRET=1\n');
    expect(lstatSync(sharedState).isSymbolicLink()).toBe(false);
    expect(lstatSync(sharedState).isFile()).toBe(true);

    /* Directory symlinks (both under $CONTROL and for custom HORNHOOF_DISK_STATE): never drop files into target dir. */
    const sDirLink = stand();
    const wDirLink = emptyWorld();
    const outsideDir1 = join(wDirLink.dir, 'outside-dir-1');
    const outsideDir2 = join(wDirLink.dir, 'outside-dir-2');
    mkdirSync(outsideDir1);
    mkdirSync(outsideDir2);
    const sharedDirLink = join(sDirLink.control, 'disk-cleaned.json');
    const customDirLink = join(wDirLink.dir, 'custom-disk-cleaned.json');
    symlinkSync(outsideDir1, sharedDirLink);
    symlinkSync(outsideDir2, customDirLink);
    expect((await runUpdaterStep(sDirLink, 'disk_care', wDirLink.env({ HORNHOOF_DISK_STATE: sharedDirLink }))).code).toBe(0);
    expect(readdirSync(outsideDir1)).toEqual([]);
    expect(lstatSync(sharedDirLink).isSymbolicLink()).toBe(false);
    expect((await runUpdaterStep(sDirLink, 'disk_care', wDirLink.env({ HORNHOOF_DISK_STATE: customDirLink }))).code).toBe(0);
    expect(readdirSync(outsideDir2)).toEqual([]);
    expect(lstatSync(customDirLink).isSymbolicLink()).toBe(false);

    /* FIFO at $CONTROL/disk-cleaned.json: refused immediately without hanging and replaced atomically. */
    const sFifo = stand();
    const wFifo = emptyWorld();
    const fifoState = join(sFifo.control, 'disk-cleaned.json');
    execFileSync('mkfifo', [fifoState]);
    const rFifo = await runUpdaterStep(sFifo, 'disk_care', wFifo.env({ HORNHOOF_DISK_STATE: fifoState }));
    expect(rFifo.code).toBe(0);
    expect(lstatSync(fifoState).isFile()).toBe(true);
    expect(wFifo.readDelivered('c-node').cleaned).toHaveLength(1);

    /* Poisoned state: extra fields, future 2099 timestamps, foreign parts, and >64 KiB bloat are stripped or rejected. */
    const sPoison = stand();
    const wPoison = emptyWorld();
    const poisonState = join(sPoison.control, 'disk-cleaned.json');
    const validAt = iso(-1800).replace('.000Z', 'Z');
    writeFileSync(
      poisonState,
      JSON.stringify([
        { part: 'images', bytes: 777, at: '2099-01-01T00:00:00Z', extra: 'x'.repeat(2000) },
        { part: 'workingCopies', bytes: 555, at: validAt },
        { part: 'volumes', bytes: -10, at: validAt },
        { part: 'volumes', bytes: 42 * MIB, at: validAt, junk: 'drop-me' },
      ]),
    );
    expect((await runUpdaterStep(sPoison, 'disk_care', wPoison.env({ HORNHOOF_DISK_STATE: poisonState }))).code).toBe(0);
    const cleanedAfter = wPoison.readDelivered('c-node').cleaned;
    expect(cleanedAfter).toEqual([
      { part: 'images', bytes: 100 * MIB, at: new Date(NOW * 1000).toISOString().replace('.000Z', 'Z') },
      { part: 'volumes', bytes: 42 * MIB, at: validAt },
    ]);
    for (const item of cleanedAfter) expect(Object.keys(item).sort()).toEqual(['at', 'bytes', 'part']);

    /* Oversized (>64 KiB) state file is rejected before jq and cannot push docker-disk.json past 64 KiB. */
    writeFileSync(
      poisonState,
      JSON.stringify([{ part: 'images', bytes: 123, at: '2099-01-01T00:00:00Z', pad: 'A'.repeat(70_000) }]),
    );
    expect((await runUpdaterStep(sPoison, 'disk_care', wPoison.env({ HORNHOOF_DISK_STATE: poisonState }))).code).toBe(0);
    expect(statSync(join(wPoison.delivered, 'c-node.json')).size).toBeLessThan(4096);
    expect(wPoison.readDelivered('c-node').cleaned).toEqual([]);
  });

  it('never passes container .Config.Env secrets to jq args or files, handles >128 KiB inspect payloads, and stays Bash 3.2 compatible', async () => {
    expect(readFileSync(join(PARTS, 'disk.sh'), 'utf8')).not.toMatch(/\b(mapfile|readarray)\b/);

    const s = stand();
    const layers = Array.from({ length: 40 }, (_, k) => `sha256:${String(k).padStart(64, '0')}`);
    const images: StubImage[] = [
      ...Array.from({ length: 5 }, (_, k) => ({
        Id: `sha256:app-${k}`,
        Created: iso(-100 * (k + 1)),
        Size: 100 * MIB,
        RepoTags: [`${APP}:0.40.${5 - k}`],
        RepoDigests: [`${APP}@sha256:${String(k).padStart(64, 'a')}`],
        RootFS: { Layers: layers },
      })),
      ...Array.from({ length: 55 }, (_, k) => ({
        Id: `sha256:other-${k}`,
        Created: iso(-1000 - k),
        Size: 50 * MIB,
        RepoTags: [`other/img:${k}`],
        RepoDigests: [`other/img@sha256:${String(k).padStart(64, 'b')}`],
        RootFS: { Layers: layers },
      })),
    ];
    const secretA = 'HORNHOOF_SECRET=TOP_SECRET_MARKER_XYZ';
    const secretB = 'POSTGRES_PASSWORD=DB_PASS_MARKER_999';
    const containers: StubContainer[] = [
      {
        Id: 'c-node',
        Name: '/hh-node',
        Image: 'sha256:app-0',
        Created: iso(-100),
        SizeRw: 20 * MIB,
        State: { Running: true, Status: 'running' },
        Config: { Labels: { 'hornhoof.subscription': 'p1' }, Env: [secretA, secretB] },
        Mounts: [],
        GraphDriver: { Data: { MergedDir: 'x'.repeat(6000) } },
      },
      ...Array.from({ length: 24 }, (_, k) => ({
        Id: `c-other-${k}`,
        Name: `/other-${k}`,
        Image: `sha256:other-${k}`,
        Created: iso(-500 - k),
        SizeRw: 5 * MIB,
        State: { Running: true, Status: 'running' },
        Config: { Labels: {}, Env: [secretA, secretB, `EXTRA=${'z'.repeat(4000)}`] },
        Mounts: [],
        GraphDriver: { Data: { MergedDir: 'y'.repeat(4000) } },
      })),
    ];
    expect(JSON.stringify(images).length).toBeGreaterThan(180_000);
    expect(JSON.stringify(containers).length).toBeGreaterThan(180_000);

    const w = dockerWorld({
      images,
      containers,
      volumes: [],
      networks: [],
      buildCacheSize: '1GiB',
      reclaimOnPrune: '0B',
      diskTotalKb: 100 * 1024 * 1024,
      diskFreeKb: 50 * 1024 * 1024,
    });
    const spyBin = join(w.dir, 'spy-bin');
    const leakLog = join(w.dir, 'jq-leaks.log');
    mkdirSync(spyBin);
    writeFileSync(leakLog, '');
    const jqSpy = `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const secrets = (process.env.DISK_JQ_FORBIDDEN || '').split(',').filter(Boolean);
const leakLog = process.env.DISK_JQ_LEAK_LOG;
const args = process.argv.slice(2);
for (const a of args) {
  for (const s of secrets) if (a.includes(s)) fs.appendFileSync(leakLog, 'ARGV_LEAK:' + s + '\\n');
}
for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--slurpfile' || args[i] === '--rawfile') && args[i + 2]) {
    const body = fs.readFileSync(args[i + 2], 'utf8');
    for (const s of secrets) if (body.includes(s)) fs.appendFileSync(leakLog, 'FILE_LEAK:' + s + '\\n');
    i += 2;
  } else if (args[i] && !args[i].startsWith('-') && fs.existsSync(args[i]) && fs.statSync(args[i]).isFile()) {
    const body = fs.readFileSync(args[i], 'utf8');
    for (const s of secrets) if (body.includes(s)) fs.appendFileSync(leakLog, 'FILE_LEAK:' + s + '\\n');
  }
}
const r = spawnSync(process.env.REAL_JQ, args, { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
`;
    writeFileSync(join(spyBin, 'jq'), jqSpy, { mode: 0o755 });
    chmodSync(join(spyBin, 'jq'), 0o755);

    const baseEnv = w.env();
    const r = await runUpdaterStep(s, 'disk_care', {
      ...baseEnv,
      PATH: `${spyBin}:${baseEnv.PATH}`,
      REAL_JQ: JQ,
      DISK_JQ_FORBIDDEN: 'TOP_SECRET_MARKER_XYZ,DB_PASS_MARKER_999',
      DISK_JQ_LEAK_LOG: leakLog,
    });
    expect(r.code).toBe(0);
    expect(readFileSync(leakLog, 'utf8')).toBe('');
    /* Kept the 2 newest Hornhoof images (app-0, app-1), removed the 3 older ones (app-2, app-3, app-4). */
    const remainingOwn = w.state().images.filter(i => i.Id.startsWith('sha256:app-')).map(i => i.Id).sort();
    expect(remainingOwn).toEqual(['sha256:app-0', 'sha256:app-1']);
    expect(w.readDelivered('c-node').parts.images).toBe(200 * MIB);
    expect(w.readDelivered('c-node').cleaned).toEqual([{ part: 'images', bytes: 300 * MIB, at: expect.any(String) }]);
  });

  it('fails closed on partial Docker inspection so failed ps or volume ls never triggers deletions or zeroed reports', async () => {
    const sPsFail = stand();
    const wPsFail = dockerWorld({
      images: [
        { Id: 'sha256:app3', Created: iso(-100), Size: 300 * MIB, RepoTags: [`${APP}:0.40.3`], RepoDigests: null },
        { Id: 'sha256:app2', Created: iso(-200), Size: 300 * MIB, RepoTags: [`${APP}:0.40.2`], RepoDigests: null },
        { Id: 'sha256:app1', Created: iso(-300), Size: 300 * MIB, RepoTags: [`${APP}:0.40.1`, `${APP}:old`], RepoDigests: null },
      ],
      containers: [
        { Id: 'c-uses-app1', Name: '/hh-app1', Image: 'sha256:app1', Created: iso(-100), SizeRw: 0, State: { Running: true, Status: 'running' }, Config: { Labels: {} }, Mounts: [] },
      ],
      volumes: [
        { Name: 'hh-lab-old-vol', CreatedAt: iso(-90_000), Labels: { 'hornhoof.lab': 'old-lab' }, Size: '1GiB' },
      ],
      networks: [],
      buildCacheSize: '0B',
      reclaimOnPrune: '0B',
      diskTotalKb: 100 * 1024 * 1024,
      diskFreeKb: 50 * 1024 * 1024,
      failCmd: ['ps'],
    });
    expect((await runUpdaterStep(sPsFail, 'disk_care', wPsFail.env())).code).toBe(0);
    expect(wPsFail.calls().some(c => c.startsWith('docker rmi'))).toBe(false);
    expect(wPsFail.calls().some(c => c.startsWith('docker volume rm'))).toBe(false);
    expect(wPsFail.state().images).toHaveLength(3);
    expect(wPsFail.state().volumes).toHaveLength(1);
    expect(readdirSync(wPsFail.delivered)).toEqual([]);

    const sVolFail = stand();
    const wVolFail = dockerWorld({
      images: [],
      containers: [
        { Id: 'c-lab-old', Name: '/hh-lab-x', Image: 'sha256:m', Created: iso(-90_000), SizeRw: 10 * MIB, State: { Running: false, Status: 'exited' }, Config: { Labels: { 'hornhoof.lab': 'x-lab' } }, Mounts: [] },
      ],
      volumes: [
        { Name: 'hh-lab-x-fresh', CreatedAt: iso(-600), Labels: { 'hornhoof.lab': 'x-lab' }, Size: '1GiB' },
      ],
      networks: [],
      buildCacheSize: '0B',
      reclaimOnPrune: '0B',
      diskTotalKb: 100 * 1024 * 1024,
      diskFreeKb: 50 * 1024 * 1024,
      failCmd: ['volume ls'],
    });
    expect((await runUpdaterStep(sVolFail, 'disk_care', wVolFail.env())).code).toBe(0);
    expect(wVolFail.calls().some(c => c.startsWith('docker rm'))).toBe(false);
    expect(wVolFail.state().containers).toHaveLength(1);

    const sInspectFail = stand();
    const wInspectFail = dockerWorld({
      images: [
        { Id: 'sha256:app3', Created: iso(-100), Size: 300 * MIB, RepoTags: [`${APP}:0.40.3`], RepoDigests: null },
        { Id: 'sha256:app2', Created: iso(-200), Size: 300 * MIB, RepoTags: [`${APP}:0.40.2`], RepoDigests: null },
        { Id: 'sha256:app1', Created: iso(-300), Size: 300 * MIB, RepoTags: [`${APP}:0.40.1`, `${APP}:old`], RepoDigests: null },
      ],
      containers: [
        { Id: 'c-uses-app1', Name: '/hh-app1', Image: 'sha256:app1', Created: iso(-100), SizeRw: 0, State: { Running: true, Status: 'running' }, Config: { Labels: {} }, Mounts: [] },
      ],
      volumes: [],
      networks: [],
      buildCacheSize: '0B',
      reclaimOnPrune: '0B',
      diskTotalKb: 100 * 1024 * 1024,
      diskFreeKb: 50 * 1024 * 1024,
      failCmd: ['inspect'],
    });
    expect((await runUpdaterStep(sInspectFail, 'disk_care', wInspectFail.env())).code).toBe(0);
    expect(wInspectFail.calls().some(c => c.startsWith('docker rmi'))).toBe(false);
    expect(wInspectFail.state().images).toHaveLength(3);
  });
});

/* Unused imports guard: keep SCRIPT/PARTS referenced for direct nodes_mode check below. */
describe('updater nodes mode, Docker disk care', () => {
  it('runs disk care in nodes_mode using a private 0700 state directory rather than a predictable /tmp file', async () => {
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
    const privateTmp = join(w.dir, 'tmp');
    mkdirSync(privateTmp);
    const child = spawn('bash', ['-euo', 'pipefail', '-c', `. "${PARTS}shared.sh"; . "${PARTS}state.sh"; . "${PARTS}server.sh"; . "${PARTS}nodes.sh"; . "${PARTS}disk.sh"; disk_care`], {
      env: {
        ...process.env,
        ...w.env({ HORNHOOF_DISK_STATE: '' }),
        TMPDIR: privateTmp,
        HORNHOOF_IMAGE: APP,
        IMAGE: APP,
        NODE_IMAGE: NODE,
        UPDATER_IMAGE: UPDATER,
        CONTROL: join(w.dir, 'no-control'),
        SERVER_DIR: '',
      },
    });
    const [code] = (await once(child, 'exit')) as [number | null];
    expect(code).toBe(0);
    expect(w.readDelivered('c-node').parts.buildCache).toBe(2 * GIB);
    expect(existsSync(join(privateTmp, 'hornhoof-disk-cleaned.json'))).toBe(false);
    const privateDirs = readdirSync(privateTmp).filter(n => n.startsWith('hornhoof-disk-state.'));
    expect(privateDirs).toHaveLength(1);
    expect(statSync(join(privateTmp, privateDirs[0]!)).mode & 0o777).toBe(0o700);
    expect(existsSync(SCRIPT)).toBe(true);
  });
});
