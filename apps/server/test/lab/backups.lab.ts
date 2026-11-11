import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/auth/password.js';
import { BundleRefused, openBundle, type Manifest } from '../../src/modules/backups/bundle.js';
import { Lab, type LabMachine } from './lab.js';
import { http, installServer, joinWorker, literal, ok, ownerKey, PASSWORD, pause, quoted, setUp, signIn, sql, WEB_PORT, within, type Server, type Worker } from './steps.js';

/* One scenario on the lab's computers, with nothing standing in for a part of Hornhoof: the server makes backups, a
   worker holds them, the company is restored from one, and after the server is lost with everything on it a new one
   brings the company back from the bundle the worker kept. */
const NEW_PASSWORD = 'a better horse battery';
/* The worker looks for a restored server after this long without a leader, where a real one waits ten minutes. */
const SURVIVOR_S = 40;

type Row = { id: string; reason: string; recovery: string | null; holders: string[] };

describe('the lab, backups', () => {
  let lab: Lab;
  let m1: LabMachine;
  let m2: LabMachine;

  beforeAll(async () => {
    lab = await Lab.start({ machines: 2 });
    m1 = lab.machine(1);
    m2 = lab.machine(2);
  });

  /* HH_LAB_KEEP=1 leaves the machines for a person to look at; the label printed at the start finds them. */
  afterAll(async () => {
    if (!process.env.HH_LAB_KEEP) await lab?.stop();
  });

  /* The bundles the company's database records, newest first. */
  const bundles = async (server: LabMachine): Promise<Row[]> =>
    JSON.parse((await sql(server, `SELECT coalesce(json_agg(json_build_object('id', id, 'reason', reason, 'recovery', recovery, 'holders', holders) ORDER BY made_at DESC), '[]') FROM net.backups`)) || '[]') as Row[];
  const heldBy = async (server: LabMachine, machine: string): Promise<string[]> => JSON.parse(await sql(server, `SELECT to_json(held_backups) FROM machines WHERE id = '${machine}'`)) as string[];
  /* A command in a service's container on a machine of the lab. */
  const inside = (machine: LabMachine, folder: string, service: string, cmd: string) => machine.exec(`cd ${folder} && docker compose exec -T ${service} sh -c ${quoted(cmd)}`);
  /* A file of the worker's keeper, copied out to this computer. */
  async function copiedOut(worker: Worker, path: string, to: string): Promise<void> {
    const said = ok(await inside(worker.machine, worker.folder, 'keeper', `base64 ${path} | tr -d '\\n'`), `reading ${path}`);
    writeFileSync(to, Buffer.from(said.trim(), 'base64'));
  }
  const log = async (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

  it('keeps bundles on a worker, restores the company from one, and brings it back after its server is lost', async () => {
    /* 1. A server, set up; a worker, joined; the worker looks for a restored server sooner than a real one would. */
    const server: Server = await installServer(m1);
    await setUp(server);
    const key = await ownerKey(PASSWORD);
    expect((await http(m1, 'PUT', `${server.url}/api/me/key`, { body: { password: PASSWORD, ...key.stored } })).status).toBe(204);
    const worker = await joinWorker(server, m2, key);
    ok(await m2.exec(`cd ${worker.folder} && printf 'HORNHOOF_SURVIVOR_S=%s\\n' ${SURVIVOR_S} >> .env && docker compose up -d keeper`), "restarting the worker's keeper");
    await within(2, 'the worker has its leader again', async () => (await worker.keeper()).leader);
    await log('1. the server is set up and the worker joined');

    /* 2. The first bundle, with no recovery file yet: it stays on the server, and no dump is left in the clear. */
    const first = await within(3, 'the first bundle is recorded', async () => (await bundles(m1))[0]);
    expect(first.recovery).toBeNull();
    expect(await heldBy(m1, worker.id)).toEqual([]);
    await within(1, 'the dump is gone', async () => ok(await inside(m1, '/root/hornhoof', 'keeper', 'ls /control/dumps; ls /control/dump.json 2>/dev/null || true'), 'ls').trim() === '');
    expect(ok(await inside(m1, '/root/hornhoof', 'keeper', 'printf "%s %s" "$(stat -c "%a %u" /control/dumps)" "$(id -u)"'), 'stat').trim()).toMatch(/^700 (\d+) \1$/);
    await log('2. the first bundle is on the server alone');

    /* 3. The CEO saves the recovery file: the next bundle is sealed for it, and the worker holds it without being able
       to open it. */
    const saved = await http(m1, 'POST', `${server.url}/api/backups/recovery`);
    expect(saved.status, saved.body).toBe(200);
    const recoveryText = saved.json<{ text: string }>().text;
    const file = JSON.parse(recoveryText.split('\n')[1]!) as { recipient: string; identity: string };
    const sealed = await within(3, 'a bundle for the recovery file is recorded', async () => (await bundles(m1)).find(row => row.recovery === file.recipient));
    await within(3, 'the worker holds it', async () => (await heldBy(m1, worker.id)).includes(sealed.id));
    expect(ok(await inside(m2, worker.folder, 'keeper', 'ls /keeper/bundles'), 'ls').trim().split('\n').sort()).toEqual([`${sealed.id}.age`, `${sealed.id}.head`]);
    const out = mkdtempSync(join(tmpdir(), 'hh-lab-bundle-'));
    await copiedOut(worker, `/keeper/bundles/${sealed.id}.age`, join(out, 'bundle.age'));
    await copiedOut(worker, `/keeper/bundles/${sealed.id}.head`, join(out, 'bundle.head'));
    const manifest = JSON.parse((JSON.parse(ok(await inside(m2, worker.folder, 'keeper', `cat /keeper/bundles/${sealed.id}.head`), 'the head')) as { manifest: string }).manifest) as Manifest;
    const workersKey = ok(await inside(m2, worker.folder, 'keeper', 'cat /keeper/age.key'), "the worker's key").trim();
    const refusal = await openBundle(createReadStream(join(out, 'bundle.age')), manifest, [workersKey]).then(() => 'opened', err => (err instanceof BundleRefused ? err.reason : String(err)));
    expect(refusal).toBe('key');
    const opened = await openBundle(createReadStream(join(out, 'bundle.age')), manifest, [file.identity]);
    opened.dump.destroy();
    expect(opened.secrets.HORNHOOF_SECRET).toBe(server.secret);
    expect(createHash('sha256').update(ok(await inside(m2, worker.folder, 'keeper', `base64 /keeper/bundles/${sealed.id}.age | tr -d '\\n'`), 'sha').trim(), 'base64').digest('hex')).toBe(manifest.sha256);
    await log('3. the worker holds a bundle it cannot open, and the recovery file opens it');

    /* 4. After that bundle the company changes: a department is made and the owner's password changed. The owner
       restores the bundle, and leaves out what came after it; the lab of merges brings such work back. */
    await sql(m1, `INSERT INTO departments (company_id, name, role_code) SELECT id, 'Made later', 'LAT' FROM companies`);
    await sql(m1, `UPDATE people SET password_hash = ${literal(await hashPassword(NEW_PASSWORD))} WHERE is_owner`);
    const restore = await http(m1, 'POST', `${server.url}/api/backups/${sealed.id}/restore`, { body: { bringBack: false } });
    expect(restore.status, restore.body).toBe(202);
    const status = async () => JSON.parse(ok(await inside(m1, '/root/hornhoof', 'keeper', 'cat /control/restore-status.json'), 'the status')) as { state: string; step: string; line: string; kept: string | null };
    const ended = await within(4, 'the restore ended', async () => {
      const said = await status().catch(() => null);
      if (said) await log(`   restore: ${said.state} at ${said.step}`);
      return said && said.state !== 'running' ? said : null;
    });
    expect(ended, ended.line).toMatchObject({ state: 'done', step: 'start' });
    await within(1, 'the restored company answers', async () => (await http(m1, 'GET', `${server.url}/api/health`)).status === 200);
    /* Everyone signs in again, and with the password of now, not the one the bundle was made with. */
    await within(2, 'the owner signs in with the password of now', async () => (await signIn(m1, server.url, NEW_PASSWORD)) === 200);
    expect(await signIn(m1, server.url, PASSWORD)).toBe(401);
    expect(await signIn(m1, server.url, NEW_PASSWORD)).toBe(200);
    expect(await sql(m1, `SELECT count(*) FROM departments WHERE name = 'Made later'`)).toBe('0');
    /* The database from before is kept until it is saved as a backup, and no other is. */
    expect((await sql(m1, `SELECT datname FROM pg_database WHERE datname LIKE 'hornhoof_before_%'`)).split('\n').filter(Boolean).every(name => name === ended.kept)).toBe(true);
    expect(ok(await inside(m1, '/root/hornhoof', 'keeper', 'ls /control/restore-carry.json 2>/dev/null; ls /control/restore | grep -v incoming; true'), 'ls').trim()).toBe('');
    await within(2, "the worker's keeper names a leader", async () => (await worker.keeper()).leader);
    expect(ok(await inside(m2, worker.folder, 'keeper', 'ls /keeper/bundles'), 'ls')).toContain(`${sealed.id}.age`);
    const newer = await within(3, 'a newer bundle of the restored company is recorded and held by the worker', async () => {
      const row = (await bundles(m1)).find(one => one.reason !== 'fork' && one.recovery === file.recipient && one.id !== sealed.id);
      return row && (await heldBy(m1, worker.id)).includes(row.id) ? row : null;
    });
    await log('4. the company is restored from the bundle, and makes bundles again');

    /* 5. The server is lost with everything on it. A new one is set up at its address, with a secret of its own. */
    await lab.remove(1);
    const m3 = await lab.add({ ip: m1.address });
    expect(m3.address).toBe(m1.address);
    const fresh = await installServer(m3, { url: server.url });
    expect(fresh.secret).not.toBe(server.secret);
    /* Before it has the recovery file it takes nothing from anybody: the worker asks, and is refused. */
    expect((await http(m3, 'GET', `${fresh.url}/api/recovery?code=${fresh.code}`)).status).toBe(404);
    const workerLog = async () => (await m2.exec(`cd ${worker.folder} && docker compose logs --no-color keeper 2>&1 | grep 'survivor:' || true`)).out;
    await within(4, 'the worker asked the new server, and was refused', async () => (await workerLog()).includes(`survivor: http://${m3.address}:${WEB_PORT} refused`));
    expect(ok(await inside(m3, '/root/hornhoof', 'keeper', 'ls /control/restore/incoming 2>/dev/null; true'), 'ls').trim()).toBe('');
    await log('5. a new server stands at the old address, and takes nothing without the recovery file');

    /* Whoever has its setup code gives it the file: the worker's next look finds it, and sends what it holds. */
    const begun = await http(m3, 'POST', `${fresh.url}/api/recovery`, { body: { code: fresh.code, file: recoveryText } });
    expect(begun.status, begun.body).toBe(200);
    type Recovery = { bundles: { id: string }[] };
    const listed = await within(3, 'the new server lists a bundle the worker sent', async () => {
      const said = await http(m3, 'GET', `${fresh.url}/api/recovery?code=${fresh.code}`);
      return said.status === 200 && said.json<Recovery>().bundles.length > 0 ? said.json<Recovery>().bundles : null;
    });
    expect(listed.map(bundle => bundle.id)).toContain(newer.id);
    const asked = await http(m3, 'POST', `${fresh.url}/api/recovery/restore`, { body: { code: fresh.code, id: newer.id } });
    expect(asked.status, asked.body).toBe(202);
    await within(6, 'the company is back on the new server', async () => {
      const said = await http(m3, 'GET', `${fresh.url}/api/setup`);
      return said.status === 200 && said.json<{ needed: boolean }>().needed === false;
    });
    /* The company as the bundle had it: the owner, with the password of step 4, and the worker's machine. */
    await within(2, 'the owner signs in on the new server', async () => (await signIn(m3, fresh.url, NEW_PASSWORD)) === 200);
    type Machines = { machines: { id: string }[] };
    expect((await http(m3, 'GET', `${fresh.url}/api/machines`)).json<Machines>().machines.map(machine => machine.id)).toContain(worker.id);
    const newId = ok(await m3.exec("sed -n 's/^HORNHOOF_MACHINE_ID=//p' /root/hornhoof/.env"), 'the machine id').trim();
    await within(2, "the only server's row is the new server's", async () => (await sql(m3, `SELECT string_agg(network_id, ',') FROM machines WHERE machine_key LIKE 'server:%' AND revoked_at IS NULL`)) === newId);
    /* The settings the bundle carried are the server's now: the stored keys open with the old secret. */
    expect(ok(await m3.exec("sed -n 's/^HORNHOOF_SECRET=//p' /root/hornhoof/.env"), 'the secret').trim()).toBe(server.secret);
    const found = await within(3, 'the worker finds its new leader, directly', async () => {
      const said = await worker.keeper().catch(() => null);
      return said?.leader?.path === 'direct' ? said : null;
    });
    expect(found.disconnected).toBe(false);
    await log('6. the company is back from the bundle the worker kept');
    await pause(0);
  });
});
