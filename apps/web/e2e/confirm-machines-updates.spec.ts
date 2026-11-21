import { expect, test, type Locator, type Page } from '@playwright/test';
import type { BackupBundle, BackupsView, ComputerAccessView, DataView, MachineView, MoveView, Org, Question } from '../src/types';
import { ME, serveApi } from './api';

/* Every Group B critical action (Machines, Access, Programs, Backups, Restore, Recovery Question, Updates) goes through
   ConfirmAction: Cancel and Escape send zero mutations, and confirming with the action's own verb sends the mutation once. */

const GIB = 1024 ** 3;
const BUNDLE_ID = '0f0f0f0f-0000-4000-8000-00000000000a';
const DUMPED = '2026-11-10T08:00:00.000Z';
const KEPT_AT = '2026-11-10T09:00:00.000Z';
const RECOVERY_FILE = '# Hornhoof recovery file for Acme.\n{"v":1}\n';
const ORG: Org = { company: ME.company, orchestrator: null, agents: { total: 0, working: 0 }, people: [], departments: [] };

const placed = (over: Partial<DataView>): DataView => ({ number: null, why: null, pin: null, unfit: null, copy: null, leftAt: null, ...over });

function makeAccess(open = true): ComputerAccessView {
  return {
    machine: { id: 'm1', networkId: 'n1', name: 'dev-laptop', hostname: 'dev-laptop', personId: 'p1', role: 'worker', os: 'linux', data: false },
    reachable: true, open, scope: open ? 'orchestrator' : null, employees: [], canOpen: true, canClose: true,
  };
}

function makeMachines(access: ComputerAccessView, keepsBackups: boolean): MachineView[] {
  return [
    {
      id: 'm1', hostname: 'dev-laptop', os: 'linux', arch: 'x86_64', owner: { id: 'p1', name: 'Ivan' }, online: true, lastSeenAt: null,
      plans: [{ id: 's1', provider: 'claude', status: 'ready', online: true }],
      load: { cpus: 8, load: 1, memFree: 10 * GIB, memTotal: 16 * GIB, jobs: 0, tests: 0, cpuModel: 'AMD EPYC', diskFree: 200 * GIB, diskTotal: 500 * GIB },
      lendsTests: true, running: { agents: [], parts: [] },
      programs: [{ id: 'claude', version: '2.1.0', updating: false, failed: false }],
      keepsBackups, heldBackups: 2, access, data: placed({ number: 1, why: 'server' }),
    },
    {
      id: 'm2', hostname: 'build-box', os: 'linux', arch: 'x86_64', owner: { id: 'p1', name: 'Ivan' }, online: true, lastSeenAt: null,
      plans: [],
      load: { cpus: 8, load: 1, memFree: 10 * GIB, memTotal: 16 * GIB, jobs: 0, tests: 0, cpuModel: 'AMD EPYC', diskFree: 200 * GIB, diskTotal: 500 * GIB },
      lendsTests: true, running: { agents: [], parts: [] },
      programs: [], keepsBackups: null, heldBackups: null, data: placed({ number: 2, why: 'always.best_link', copy: { line: 'ready' } }),
    },
  ];
}

const dialog = (page: Page, name?: string) => (name ? page.getByRole('alertdialog', { name }) : page.getByRole('alertdialog'));

async function cancelAndEscape(page: Page, trigger: Locator, title: string, verify?: (box: Locator) => Promise<void>) {
  await trigger.click();
  const box = dialog(page, title);
  await expect(box).toBeVisible();
  if (verify) await verify(box);
  await box.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await trigger.click();
  await expect(dialog(page, title)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
}

test('confirms machine disconnect, backups toggle, server move, stop move, computer access, and program updates', async ({ page }) => {
  await serveApi(page);
  let keepsBackups = true;
  let access = makeAccess(true);
  let move: MoveView | null = null;
  let machines = makeMachines(access, keepsBackups);
  const mutations: { method: string; path: string; body?: unknown }[] = [];

  await page.route('**/api/org', route => route.fulfill({ json: ORG }));
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [] } }));
  await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/machines/*/connections', route => route.fulfill({ json: { summary: { drops: 0, averageMs: null, cause: null }, events: [] } }));
  await page.route('**/api/machines', route => route.fulfill({ json: { machines, builtin: null, priority: true, move, canMove: true, copies: null } }));
  await page.route('**/api/machines/access', route => route.fulfill({ json: { views: [access] } }));
  await page.route(/\/api\/machines\/[^/]+(\/.*)?$/, route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    if (method === 'GET') return route.fallback();
    const body = req.postData() ? req.postDataJSON() : undefined;
    mutations.push({ method, path, body });
    if (path === '/api/machines/m1' && method === 'PATCH') {
      keepsBackups = Boolean((body as { keepsBackups?: boolean })?.keepsBackups);
      machines = makeMachines(access, keepsBackups);
      return route.fulfill({ json: { lendsTests: true, keepsBackups } });
    }
    if (path === '/api/machines/m1/access/close') {
      access = makeAccess(false);
      machines = makeMachines(access, keepsBackups);
      return route.fulfill({ json: access });
    }
    if (path === '/api/machines/m1/access/open') {
      access = makeAccess(true);
      machines = makeMachines(access, keepsBackups);
      return route.fulfill({ json: access });
    }
    if (path === '/api/machines/m1/programs/update') return route.fulfill({ status: 202, json: { updating: true } });
    if (path === '/api/machines/m2/move' && method === 'POST') {
      move = { machine: 'm2', state: 'preparing', reason: null, leader: 'dev-laptop', progress: 40 };
      return route.fulfill({ status: 202, json: { state: 'preparing' } });
    }
    if (path === '/api/machines/m2/move' && method === 'DELETE') {
      move = null;
      return route.fulfill({ status: 204 });
    }
    if (path === '/api/machines/m1/disconnect') {
      machines = machines.filter(m => m.id !== 'm1');
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 204 });
  });

  await page.goto('/machines');
  await page.getByRole('button', { name: 'Open the card of dev-laptop', exact: true }).click();
  const laptop = page.getByRole('article', { name: 'dev-laptop' });

  /* 1. Keep company backups OFF (danger) and ON (ordinary). */
  const keepBox = laptop.getByRole('checkbox', { name: "Keep the company's backups on dev-laptop" });
  await expect(keepBox).toBeChecked();
  await cancelAndEscape(page, keepBox, 'Do you really want to stop keeping company backups on this machine?', async box => {
    await expect(box.locator('p bdi')).toHaveText('dev-laptop');
    await expect(box.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  });
  await expect(keepBox).toBeChecked();
  expect(mutations).toEqual([]);
  await keepBox.click();
  await dialog(page).getByRole('button', { name: 'Stop keeping backups', exact: true }).click();
  await expect(keepBox).not.toBeChecked();
  expect(mutations).toEqual([{ method: 'PATCH', path: '/api/machines/m1', body: { keepsBackups: false } }]);

  await cancelAndEscape(page, keepBox, 'Do you really want to keep company backups on this machine?', async box => {
    await expect(box.locator('p bdi')).toHaveText('dev-laptop');
    await expect(box.getByRole('button', { name: 'Keep backups', exact: true })).toBeFocused();
  });
  await expect(keepBox).not.toBeChecked();
  expect(mutations).toHaveLength(1);
  await keepBox.click();
  await dialog(page).getByRole('button', { name: 'Keep backups', exact: true }).click();
  await expect(keepBox).toBeChecked();
  expect(mutations).toHaveLength(2);

  /* 2. Close computer access (danger) and reopen it (ordinary). */
  const closeAccess = laptop.getByRole('button', { name: 'Close access', exact: true });
  await cancelAndEscape(page, closeAccess, 'Do you really want to close access to this machine?', async box => {
    await expect(box.locator('p bdi')).toHaveText('dev-laptop');
    await expect(box.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  });
  expect(mutations).toHaveLength(2);
  await closeAccess.click();
  await dialog(page).getByRole('button', { name: 'Close access', exact: true }).click();
  const reopenAccess = laptop.getByRole('button', { name: 'Reopen access', exact: true });
  await expect(reopenAccess).toBeVisible();
  expect(mutations).toHaveLength(3);

  await cancelAndEscape(page, reopenAccess, 'Do you really want to open access to this machine?', async box => {
    await expect(box.locator('p bdi')).toHaveText('dev-laptop');
    await expect(box.getByRole('button', { name: 'Open access', exact: true })).toBeFocused();
  });
  expect(mutations).toHaveLength(3);
  await reopenAccess.click();
  await dialog(page).getByRole('button', { name: 'Open access', exact: true }).click();
  await expect(laptop.getByRole('button', { name: 'Close access', exact: true })).toBeVisible();
  expect(mutations).toHaveLength(4);

  /* 3. Update agent programs on a named machine. */
  const updatePrograms = laptop.getByRole('button', { name: 'Update programs', exact: true });
  await cancelAndEscape(page, updatePrograms, 'Do you really want to update agent programs?', async box => {
    await expect(box.locator('p bdi')).toHaveText('dev-laptop');
    await expect(box.getByRole('button', { name: 'Update', exact: true })).toBeFocused();
  });
  expect(mutations).toHaveLength(4);
  await updatePrograms.click();
  await dialog(page).getByRole('button', { name: 'Update', exact: true }).click();
  await expect.poll(() => mutations.length).toBe(5);
  expect(mutations[4]).toEqual({ method: 'POST', path: '/api/machines/m1/programs/update', body: undefined });

  /* 4. Move the company server to build-box, then stop the move. */
  await page.getByRole('button', { name: 'Open the card of build-box', exact: true }).click();
  const buildBox = page.getByRole('article', { name: 'build-box' });
  const moveHere = buildBox.getByRole('button', { name: 'Move the server here', exact: true });
  await cancelAndEscape(page, moveHere, 'Do you really want to move the company server?', async box => {
    await expect(box.locator('p bdi')).toHaveText('build-box');
    await expect(box).toContainText('Hornhoof stops for a short while as it moves; your work is kept.');
    await expect(box.getByRole('button', { name: 'Move server', exact: true })).toBeFocused();
  });
  expect(mutations).toHaveLength(5);
  await moveHere.click();
  await dialog(page).getByRole('button', { name: 'Move server', exact: true }).click();
  const stopMove = buildBox.getByRole('button', { name: 'Cancel the move', exact: true });
  await expect(stopMove).toBeVisible();
  expect(mutations[5]).toEqual({ method: 'POST', path: '/api/machines/m2/move', body: undefined });

  await cancelAndEscape(page, stopMove, 'Do you really want to stop moving the server?', async box => {
    await expect(box.locator('p bdi')).toHaveText('build-box');
    await expect(box.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  });
  expect(mutations).toHaveLength(6);
  await stopMove.click();
  await dialog(page).getByRole('button', { name: 'Stop move', exact: true }).click();
  await expect(buildBox.getByRole('button', { name: 'Move the server here', exact: true })).toBeVisible();
  expect(mutations[6]).toEqual({ method: 'DELETE', path: '/api/machines/m2/move', body: undefined });

  /* 5. Disconnect dev-laptop (danger + Claude sign-in warning). */
  const disconnect = laptop.getByRole('button', { name: 'Disconnect dev-laptop', exact: true });
  await cancelAndEscape(page, disconnect, 'Do you really want to disconnect this machine?', async box => {
    await expect(box.locator('p bdi')).toHaveText('dev-laptop');
    await expect(box).toContainText('revoke its Claude sign-in at claude.ai');
    await expect(box.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  });
  expect(mutations).toHaveLength(7);
  await disconnect.click();
  await dialog(page).getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect.poll(() => mutations.length).toBe(8);
  expect(mutations[7]).toEqual({ method: 'POST', path: '/api/machines/m1/disconnect', body: undefined });
});

test('confirms leaving a kept database out and restoring a backup in Settings without losing RestoreAsk state', async ({ page }) => {
  await serveApi(page);
  let left = false;
  let restoring = false;
  const posts: { path: string; body?: unknown }[] = [];
  const bundle: BackupBundle = {
    id: BUNDLE_ID, dumpedAt: DUMPED, reason: 'timer', size: 5 * 1024 * 1024, recovery: 'current',
    where: [{ machine: null, name: 'this server', online: true }], restorable: true, why: null,
  };
  const view = (): BackupsView => ({
    last: DUMPED, recovery: { madeAt: '2026-11-09T10:00:00.000Z', madeBy: 'Ivan' }, recoveryNeeded: false, linkChanged: false,
    restore: restoring ? { attempt: 'a1', id: BUNDLE_ID, state: 'running', step: 'fetch', line: 'Getting the backup.', at: DUMPED, kept: null } : null,
    kept: [{ name: 'hornhoof_before_20261110_090000', at: KEPT_AT, merge: { id: 'm1', status: left ? 'removing' : 'pending', added: 0, conflicts: 0, error: null } }],
    bundles: [bundle],
  });

  await page.route('**/api/org', route => route.fulfill({ json: ORG }));
  await page.route('**/api/link', route => route.fulfill({ json: { link: null, domain: 'hornhoof.org', tls: null } }));
  await page.route('**/api/backups', route => route.fulfill({ json: view() }));
  await page.route(`**/api/backups/${BUNDLE_ID}/warning`, route => route.fulfill({ json: { machines: [], people: [] } }));
  await page.route('**/api/backups/kept/*/leave', route => {
    left = true;
    posts.push({ path: new URL(route.request().url()).pathname });
    return route.fulfill({ status: 204 });
  });
  await page.route(`**/api/backups/${BUNDLE_ID}/restore`, route => {
    restoring = true;
    posts.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    return route.fulfill({ status: 202, json: { attempt: 'a1' } });
  });

  await page.goto('/settings/company');

  /* Leave a kept database out. */
  const leaveButton = page.getByRole('button', { name: /^Leave out the database from before the restore of / });
  await cancelAndEscape(page, leaveButton, 'Do you really want to leave this database out?', async box => {
    await expect(box.locator('p bdi')).toHaveCount(1);
    await expect(box).toContainText('What it held after the backup will not come back.');
    await expect(box).toContainText('This cannot be undone.');
    await expect(box.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  });
  expect(posts).toEqual([]);
  await leaveButton.click();
  await dialog(page).getByRole('button', { name: 'Leave out', exact: true }).click();
  await expect(page.getByText('Left out. Removed once its backup is made.')).toBeVisible();
  expect(posts).toEqual([{ path: '/api/backups/kept/hornhoof_before_20261110_090000/leave' }]);

  /* Restore a backup: untick bringBack, cancel & escape keep RestoreAsk and unticked box intact. */
  await page.getByRole('button', { name: /^Restore the backup of / }).click();
  const ask = page.getByRole('group', { name: /^Restore the company/ });
  const bring = ask.getByRole('checkbox', { name: /^Bring back what came after / });
  await bring.uncheck();
  const restoreButton = ask.getByRole('button', { name: 'Restore', exact: true });
  await cancelAndEscape(page, restoreButton, 'Do you really want to restore this backup?', async box => {
    await expect(box.locator('p bdi')).toHaveCount(1);
    await expect(box).toContainText('does not come back.');
    await expect(box).toContainText('Everyone signs in again afterwards.');
    await expect(box).toContainText('This cannot be undone.');
    await expect(box.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  });
  await expect(bring).not.toBeChecked();
  expect(posts).toHaveLength(1);
  await restoreButton.click();
  await dialog(page).getByRole('button', { name: 'Restore', exact: true }).click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toEqual({ path: `/api/backups/${BUNDLE_ID}/restore`, body: { bringBack: false } });
});

test('confirms restoring a backup on a replacement server', async ({ page }) => {
  await serveApi(page);
  const restores: unknown[] = [];
  let running = false;
  await page.route('**/api/me', route => route.fulfill({ status: 401, json: { error: { code: 'unauthorized' } } }));
  await page.route('**/api/setup', route => route.fulfill({ json: { needed: true, linkDomain: 'hornhoof.org', recovering: false } }));
  await page.route('**/api/recovery', route => route.fulfill({ json: { bundles: [{ id: BUNDLE_ID, dumpedAt: DUMPED, size: 4096 }], restore: null } }));
  await page.route('**/api/recovery?*', route => route.fulfill({ json: {
    bundles: [{ id: BUNDLE_ID, dumpedAt: DUMPED, size: 4096 }],
    restore: running ? { attempt: 'a1', id: BUNDLE_ID, state: 'running', step: 'fetch', line: 'Getting the backup.', at: DUMPED, kept: null } : null,
  } }));
  await page.route('**/api/recovery/restore', route => {
    running = true;
    restores.push(route.request().postDataJSON());
    return route.fulfill({ status: 202, json: { attempt: 'a1' } });
  });

  await page.goto('/setup?code=LINK-CODE-123');
  await page.getByRole('button', { name: 'Restore from a recovery file', exact: true }).click();
  await page.getByLabel('Recovery file').setInputFiles({ name: 'hornhoof-recovery.txt', mimeType: 'text/plain', buffer: Buffer.from(RECOVERY_FILE) });

  const pick = page.getByRole('button', { name: /^Restore the backup of / });
  await expect(pick).toBeVisible();
  await cancelAndEscape(page, pick, 'Do you really want to restore this backup?', async box => {
    await expect(box.locator('p bdi')).toHaveCount(1);
    await expect(box).toContainText('This cannot be undone.');
    await expect(box.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  });
  await expect(page.getByLabel('Or upload a backup file')).toBeVisible();
  expect(restores).toEqual([]);
  await pick.click();
  await dialog(page).getByRole('button', { name: 'Restore', exact: true }).click();
  await expect.poll(() => restores).toEqual([{ code: 'LINK-CODE-123', id: BUNDLE_ID }]);
});

test('confirms continuing from a company copy while Wait for leader stays direct', async ({ page }) => {
  await serveApi(page);
  const [A, B] = ['a'.repeat(64), 'b'.repeat(64)];
  const question: Question = {
    since: '2026-11-12T14:02:30.000Z',
    leader: { networkId: A, host: 'rack-01', heard: '2026-11-12T14:02:00.000Z' },
    copies: [{ networkId: B, host: 'dev-studio', number: 2, reach: '2026-11-12T14:01:40.000Z', self: true }],
    waiting: null,
  };
  const posts: { path: string; body?: unknown }[] = [];
  await page.route('**/api/org', route => route.fulfill({ json: ORG }));
  await page.route('**/api/network/question', route => route.fulfill({ json: { question, canAnswer: true } }));
  await page.route('**/api/network/question/*', route => {
    posts.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    return route.fulfill({ status: 204 });
  });

  await page.goto('/');
  const banner = page.getByRole('group', { name: 'The server stopped answering' });
  await expect(banner).toBeVisible();

  /* Wait for leader needs no confirmation. */
  await banner.getByRole('button', { name: 'Wait for rack-01', exact: true }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/network/question/wait', body: {} }]);
  await expect(dialog(page)).toHaveCount(0);

  /* Continuing from a copy requires confirmation naming machine and reach time in <bdi>. */
  const goOn = banner.getByRole('button', { name: /^Go on from / });
  await cancelAndEscape(page, goOn, 'Do you really want to continue from this copy?', async box => {
    await expect(box.locator('p bdi')).toHaveCount(2);
    await expect(box.locator('p bdi').first()).toHaveText('dev-studio');
    await expect(box).toContainText('Only if rack-01 is off.');
    await expect(box).toContainText('This cannot be undone.');
    await expect(box.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  });
  expect(posts).toHaveLength(1);
  await goOn.click();
  await dialog(page).getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toEqual({ path: '/api/network/question/go-on', body: { networkId: B, reach: '2026-11-12T14:01:40.000Z' } });
});

test('confirms updates from the banner, active-turns cut dialog, and Versions builds', async ({ page }) => {
  await serveApi(page);
  const current = { version: '0.5.0', commit: 'a'.repeat(40), migrations: 51 };
  const newer = { tag: 'latest', version: '0.5.1', commit: 'b'.repeat(40), created: '2026-11-03T10:00:00Z', title: 'New build', migrations: 52 };
  const older = { tag: '0.4.0', version: '0.4.0', commit: 'c'.repeat(40), created: '2026-10-20T10:00:00Z', title: 'Old build', migrations: 50 };
  const posts: unknown[] = [];

  await page.route('**/api/org', route => route.fulfill({ json: ORG }));
  await page.route('**/api/version', route => route.fulfill({ json: current }));
  await page.route('**/api/updates', route => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { current, available: true, checkedAt: '2026-11-03T10:00:00Z', latest: newer, versions: [newer, older], error: null, updater: { present: true, status: null, waiting: null } } });
    }
    const body = route.request().postDataJSON() as { version: string; whenIdle: boolean; confirmTurns?: number };
    posts.push(body);
    if (!body.whenIdle && !body.confirmTurns) {
      return route.fulfill({ status: 409, json: { error: { code: 'conflict', reason: 'turns_would_stop', message: 'Running turns would stop.', details: { turns: 2 } } } });
    }
    return route.fulfill({ status: 202, json: { id: 'u1' } });
  });

  await page.goto('/');
  const banner = page.getByRole('status', { name: 'Hornhoof update' });
  const updateBtn = banner.getByRole('button', { name: 'Update', exact: true });

  /* Banner Update now: Cancel/Escape sends nothing; confirm hits turns_would_stop -> UpdateCut opens. */
  await cancelAndEscape(page, updateBtn, 'Do you really want to update Hornhoof?', async box => {
    await expect(box.locator('p bdi')).toHaveText('0.5.1 (bbbbbbb)');
    await expect(box.getByRole('button', { name: 'Update', exact: true })).toBeFocused();
  });
  expect(posts).toEqual([]);
  await updateBtn.click();
  await dialog(page, 'Do you really want to update Hornhoof?').getByRole('button', { name: 'Update', exact: true }).click();

  /* UpdateCut renders through ConfirmAction (danger: focus on Cancel). Cancel sends no second POST. */
  const cut = dialog(page, 'Update now?');
  await expect(cut).toContainText('2 agent turns are running.');
  await expect(cut.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await cut.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(posts).toEqual([{ version: 'latest', whenIdle: false }]);

  /* "Update when agents finish" stays direct with no confirmation dialog. */
  await banner.getByRole('button', { name: 'Update when agents finish', exact: true }).click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toEqual({ version: 'latest', whenIdle: true });
  await expect(dialog(page)).toHaveCount(0);

  /* Versions: newer build (ordinary) and older-migration build (danger + pastMigration warning). */
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Versions', exact: true }).click();
  const versions = page.getByRole('dialog', { name: 'Versions' });

  const installNewer = versions.getByRole('listitem').filter({ hasText: '0.5.1 (bbbbbbb)' }).getByRole('button', { name: 'Install', exact: true });
  await cancelAndEscape(page, installNewer, 'Do you really want to install this build?', async box => {
    await expect(box.locator('p bdi')).toHaveText('0.5.1 (bbbbbbb)');
    await expect(box.getByRole('button', { name: 'Install', exact: true })).toBeFocused();
  });
  await expect(versions).toBeVisible();
  expect(posts).toHaveLength(2);

  const installOlder = versions.getByRole('listitem').filter({ hasText: '0.4.0 (ccccccc)' }).getByRole('button', { name: 'Install', exact: true });
  await cancelAndEscape(page, installOlder, 'Do you really want to go back to this build?', async box => {
    await expect(box.locator('p bdi')).toHaveText('0.4.0 (ccccccc)');
    await expect(box).toContainText('Going back past a database change may not start.');
    await expect(box.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  });
  expect(posts).toHaveLength(2);

  await installOlder.click();
  await dialog(page, 'Do you really want to go back to this build?').getByRole('button', { name: 'Go back', exact: true }).click();
  /* Confirming UpdateCut sends confirmTurns once and closes it. */
  const cutAgain = dialog(page, 'Update now?');
  await expect(cutAgain).toBeVisible();
  await cutAgain.getByRole('button', { name: 'Update now', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(posts.slice(2)).toEqual([
    { version: '0.4.0', whenIdle: false },
    { version: '0.4.0', whenIdle: false, confirmTurns: 2 },
  ]);
});
