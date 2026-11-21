import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { Department, Employee, GoalView, MachineView, Me, Org, SubView, TaskLine } from '../src/types';
import { computeCoachPlacement } from '../src/guide/placement';
import { deriveGuideState, hasConfirmedWorkStart, resumeTargetRoute } from '../src/guide/state';
import {
  clearPreSetupGuide,
  consumeSetupHandoff,
  loadGuideRecord,
  loadPreSetupGuide,
  recordSetupHandoff,
  saveGuideRecord,
  savePreSetupGuide,
} from '../src/guide/storage';
import { GUIDE_STEPS, type GuideRecord, type GuideSnapshot } from '../src/guide/types';
import { guideCompanionKind, registerGuideVoice, resolveGuideVoice } from '../src/guide/voices';

const NOW = Date.parse('2026-11-21T14:00:00Z');

const ME: Me = {
  person: {
    id: 'p1', companyId: 'c1', name: 'Ivan', email: 'ivan@acme.com', title: 'CEO',
    status: 'active', scopeKind: 'company', isOwner: true,
  },
  company: { id: 'c1', name: 'Acme' },
};

const OPERATIONS: Department = {
  id: 'd-ops', name: null, templateKey: 'operations', roleCode: 'OPS', about: '',
  agents: { total: 1, working: 0 }, products: [], teams: [], people: [],
  employees: [
    {
      id: 'e-ops', name: 'Ops Head', roleId: 'r-ops', title: { en: 'Ops Head', ru: 'Глава операций' },
      kind: 'head', model: 'sonnet', modelName: 'Sonnet', provider: 'claude', effort: null,
      state: 'sleeping', status: 'idle', on: true, timer: null, task: null, context: null,
      program: null, alarm: null, retry: null, failure: null,
    },
  ],
  roles: [],
};

function makeEmployee(patch: Partial<Employee> = {}): Employee {
  return {
    id: 'e1', name: 'Neo', roleId: 'r1', title: { en: 'Team lead', ru: 'Руководитель отдела' },
    kind: 'head', model: 'sonnet', modelName: 'Sonnet', provider: 'claude', effort: null,
    state: 'sleeping', status: 'idle', on: true, timer: null, task: null, context: null,
    program: null, alarm: null, retry: null, failure: null,
    ...patch,
  };
}

function makeDept(patch: Partial<Department> = {}): Department {
  return {
    id: 'd1', name: 'Product', templateKey: null, roleCode: 'PRD', about: '',
    agents: { total: 0, working: 0 }, products: [], teams: [], people: [],
    employees: [], roles: [],
    ...patch,
  };
}

function makeSub(patch: Partial<SubView> = {}): SubView {
  return {
    id: 's1', provider: 'claude', kind: 'personal', label: 'Claude', status: 'ready', online: true,
    last4: null, owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company', id: null, name: 'Whole company' },
    machines: [{ id: 'm1', hostname: 'laptop', status: 'ready', online: true }],
    limits: null, limitsUpdatedAt: null, budget: null, fallbacks: [], isOrchestrator: true,
    accounts: [], tier: 'max', accountsDiffer: false, signedInOnce: true, leaseMachine: null,
    connecting: null,
    ...patch,
  };
}

function makeMachine(patch: Partial<MachineView> = {}): MachineView {
  return {
    id: 'm1', hostname: 'laptop', os: 'linux', arch: 'x86_64', owner: { id: 'p1', name: 'Ivan' },
    online: true, lastSeenAt: null, plans: [], load: null, lendsTests: false,
    running: { agents: [], parts: [] },
    ...patch,
  };
}

function makeGoal(patch: Partial<GoalView> = {}): GoalView {
  return {
    id: 'g1', number: 1, title: 'Publish first brief', why: '', status: 'active', version: 1,
    parentId: null, department: { id: 'd1', name: 'Product' },
    responsible: { id: 'p1', name: 'Ivan' }, target: null, current: null, unit: '', dueAt: null,
    progress: { done: 0, total: 0 }, createdAt: '2026-11-21T13:00:00Z',
    ...patch,
  } as GoalView;
}

function makeTask(patch: Partial<TaskLine> = {}): TaskLine {
  return {
    id: 't1', number: 1, title: 'Draft product brief', status: 'open', priority: 'normal',
    parentId: null, department: { id: 'd1', name: 'Product' }, product: null, goal: null,
    assignee: { id: 'e1', name: 'Neo' }, executor: { id: 'e1', name: 'Neo' },
    responsible: { id: 'p1', name: 'Ivan' }, paused: null, urgent: false,
    waitsFor: [], externalWait: null, pipelineId: null, pipelineStageId: null,
    ...patch,
  } as TaskLine;
}

function makeOrg(departments: Department[] = [OPERATIONS], sub: SubView | null = makeSub()): Org {
  return {
    company: ME.company,
    orchestrator: {
      id: 'orch1', name: 'Orchestrator', model: 'sonnet', effort: null,
      subscription: sub, context: null, program: null, alarm: null, retry: null, failure: null,
    },
    agents: { total: 1, working: 0 },
    people: [],
    departments,
  };
}

function makeRecord(patch: Partial<GuideRecord> = {}): GuideRecord {
  return {
    version: 1,
    active: true,
    skipped: false,
    mode: 'api_key',
    done: ['company', 'account'],
    departmentId: null,
    goalId: null,
    taskId: null,
    workConfirmed: false,
    ...patch,
  };
}

function makeSnap(patch: Partial<GuideSnapshot> = {}): GuideSnapshot {
  return {
    record: makeRecord(),
    me: ME,
    route: { kind: 'map' },
    org: makeOrg(),
    orgFailure: null,
    subs: [makeSub({ kind: 'api_key', provider: 'anthropic_api', last4: '9999' })],
    subsFailure: null,
    machines: [],
    machinesFailure: null,
    goals: [],
    goalsFailure: null,
    tasks: [],
    tasksFailure: null,
    now: NOW,
    ...patch,
  };
}

describe('deriveGuideState — branches and real confirmations', () => {
  it('treats API key on built-in node as plan+machine ready and guides to department when only Operations exists', () => {
    const apiSub = makeSub({ kind: 'api_key', provider: 'anthropic_api', status: 'ready', online: true });
    const state = deriveGuideState(makeSnap({
      record: makeRecord({ mode: 'api_key' }),
      org: makeOrg([OPERATIONS], apiSub),
      subs: [apiSub],
    }));
    expect(state.step).toBe('department');
    expect(state.phase).toBe('guidance');
    expect(state.done).toEqual(expect.arrayContaining(['company', 'account', 'plan', 'machine']));
    expect(state.done).not.toContain('department');
    expect(state.anchors[0]).toBe('AgentWindow.structureApply');
    expect(state.anchors).toContain('Map.orchestrator');
  });

  it('shows recovery on plan when API key built-in node is offline (never manual machine command)', () => {
    const offlineApi = makeSub({ kind: 'api_key', provider: 'anthropic_api', status: 'ready', online: false });
    const state = deriveGuideState(makeSnap({
      record: makeRecord({ mode: 'api_key' }),
      org: makeOrg([OPERATIONS], offlineApi),
      subs: [offlineApi],
    }));
    expect(state.step).toBe('plan');
    expect(state.phase).toBe('recovery');
  });

  it('keeps personal plan machine and login confirmations independent, and copy never closes machine', () => {
    const waitingSub = makeSub({
      kind: 'personal', status: 'waiting_machine', online: false, signedInOnce: false, machines: [],
    });
    const onMachines = deriveGuideState(makeSnap({
      record: makeRecord({ mode: 'personal' }),
      route: { kind: 'machines' },
      org: makeOrg([OPERATIONS], waitingSub),
      subs: [waitingSub],
      machines: [],
    }));
    expect(onMachines.step).toBe('machine');
    expect(onMachines.phase).toBe('guidance');
    expect(onMachines.done).not.toContain('machine');

    const onSubs = deriveGuideState(makeSnap({
      record: makeRecord({ mode: 'personal' }),
      route: { kind: 'subscriptions' },
      org: makeOrg([OPERATIONS], waitingSub),
      subs: [waitingSub],
      machines: [],
    }));
    expect(onSubs.step).toBe('plan');
    expect(onSubs.phase).toBe('waiting_machine');

    /* Machine connects online, but sign-in still required: machine confirmed, plan needs_login. */
    const needsLoginSub = makeSub({
      kind: 'personal', status: 'needs_login', online: true, signedInOnce: false,
      machines: [{ id: 'm1', hostname: 'laptop', status: 'needs_login', online: true }],
    });
    const needsLogin = deriveGuideState(makeSnap({
      record: makeRecord({ mode: 'personal' }),
      route: { kind: 'subscriptions' },
      org: makeOrg([OPERATIONS], needsLoginSub),
      subs: [needsLoginSub],
      machines: [makeMachine({ online: true })],
    }));
    expect(needsLogin.step).toBe('plan');
    expect(needsLogin.phase).toBe('needs_login');
    expect(needsLogin.done).toContain('machine');
    expect(needsLogin.done).not.toContain('plan');
    expect(needsLogin.anchors).toContain('Subscriptions.signIn');

    /* Active connecting sign-in shows loading spinner state, not error. */
    const connectingSub = makeSub({
      ...needsLoginSub,
      connecting: {
        nodeId: 'm1', hostname: 'laptop', state: 'connecting', step: 'checking',
        since: '2026-11-21T13:59:50Z', until: '2026-11-21T14:02:00Z', error: null, code: null, line: null,
      },
    });
    const loadingState = deriveGuideState(makeSnap({
      record: makeRecord({ mode: 'personal' }),
      route: { kind: 'subscriptions' },
      org: makeOrg([OPERATIONS], connectingSub),
      subs: [connectingSub],
      machines: [makeMachine({ online: true })],
    }));
    expect(loadingState.step).toBe('plan');
    expect(loadingState.phase).toBe('loading');

    /* Server deadline (too_long) or failure enters recovery pointing at retry/sign-in. */
    const failedSub = makeSub({
      ...needsLoginSub,
      connecting: {
        nodeId: 'm1', hostname: 'laptop', state: 'too_long', step: 'checking',
        since: '2026-11-21T13:55:00Z', until: '2026-11-21T13:59:00Z', error: 'timeout', code: null, line: null,
      },
    });
    const failedState = deriveGuideState(makeSnap({
      record: makeRecord({ mode: 'personal' }),
      route: { kind: 'subscriptions' },
      org: makeOrg([OPERATIONS], failedSub),
      subs: [failedSub],
      machines: [makeMachine({ online: true })],
    }));
    expect(failedState.step).toBe('plan');
    expect(failedState.phase).toBe('recovery');
    expect(failedState.anchors[0]).toBe('Subscriptions.retry');

    /* needs_setup keeps provider setup guidance without marking ready. */
    const needsSetupSub = makeSub({
      kind: 'personal', status: 'needs_setup', online: true,
      machines: [{ id: 'm1', hostname: 'laptop', status: 'needs_setup', online: true }],
    });
    const setupState = deriveGuideState(makeSnap({
      record: makeRecord({ mode: 'personal' }),
      route: { kind: 'subscriptions' },
      org: makeOrg([OPERATIONS], needsSetupSub),
      subs: [needsSetupSub],
      machines: [makeMachine({ online: true })],
    }));
    expect(setupState.step).toBe('plan');
    expect(setupState.phase).toBe('needs_setup');
    expect(setupState.done).not.toContain('plan');
  });

  it('allows Later to enter the map and returns plan guidance when hiring or template staff needs a plan', () => {
    const onMap = deriveGuideState(makeSnap({
      record: makeRecord({ mode: 'later' }),
      route: { kind: 'map' },
      org: makeOrg([OPERATIONS], null),
      subs: [],
    }));
    expect(onMap.step).toBe('department');
    expect(onMap.done).not.toContain('plan');

    const onSubs = deriveGuideState(makeSnap({
      record: makeRecord({ mode: 'later' }),
      route: { kind: 'subscriptions' },
      org: makeOrg([OPERATIONS], null),
      subs: [],
    }));
    expect(onSubs.step).toBe('plan');
    expect(onSubs.anchors).toContain('Subscriptions.connect');

    /* Template department + head exist, but waiting for a subscription: asks for plan, not duplicate dept/staff. */
    const templateDept = makeDept({
      id: 'd-tpl',
      employees: [makeEmployee({ state: 'needs_subscription', status: 'off' })],
    });
    const needsPlan = deriveGuideState(makeSnap({
      record: makeRecord({ mode: 'later' }),
      route: { kind: 'map' },
      org: makeOrg([OPERATIONS, templateDept], null),
      subs: [],
    }));
    expect(needsPlan.step).toBe('plan');
    expect(needsPlan.done).toEqual(expect.arrayContaining(['department', 'staff']));
  });

  it('skips duplicate department and staff steps for template companies that already have a head and ready plan', () => {
    const templateDept = makeDept({ id: 'd-tpl', employees: [makeEmployee()] });
    const state = deriveGuideState(makeSnap({
      org: makeOrg([OPERATIONS, templateDept]),
      goals: [],
    }));
    expect(state.step).toBe('goal');
    expect(state.done).toEqual(expect.arrayContaining(['department', 'staff']));
    expect(state.departmentId).toBe('d-tpl');
  });

  it('shows plan recovery without resetting department/staff when a historically ready plan goes offline', () => {
    const offlineSub = makeSub({ online: false, status: 'ready', machines: [{ id: 'm1', hostname: 'laptop', status: 'ready', online: false }] });
    const dept = makeDept({ id: 'd1', employees: [makeEmployee()] });
    const state = deriveGuideState(makeSnap({
      record: makeRecord({ mode: 'personal', done: ['company', 'account', 'plan', 'machine', 'department', 'staff'], departmentId: 'd1' }),
      org: makeOrg([OPERATIONS, dept], offlineSub),
      subs: [offlineSub],
      machines: [makeMachine({ online: false })],
    }));
    expect(state.step).toBe('plan');
    expect(state.phase).toBe('recovery');
    expect(state.done).toEqual(expect.arrayContaining(['department', 'staff']));
  });

  it('advances department -> staff -> goal -> task in order based on real entities', () => {
    const emptyDept = makeDept({ id: 'd1', employees: [] });
    const atStaff = deriveGuideState(makeSnap({ org: makeOrg([OPERATIONS, emptyDept]) }));
    expect(atStaff.step).toBe('staff');
    expect(atStaff.anchors).toEqual(['StaffCard.hire', 'Department.hire', 'Map.department:d1', 'Nav.map']);

    const staffedDept = makeDept({ id: 'd1', employees: [makeEmployee()] });
    const atGoal = deriveGuideState(makeSnap({ org: makeOrg([OPERATIONS, staffedDept]), goals: [] }));
    expect(atGoal.step).toBe('goal');
    expect(atGoal.anchors).toEqual(['GoalForm.title', 'Tracker.newGoal', 'Tracker.create', 'Nav.tasks']);

    const atTask = deriveGuideState(makeSnap({
      org: makeOrg([OPERATIONS, staffedDept]),
      goals: [makeGoal()],
      tasks: [],
    }));
    expect(atTask.step).toBe('task');
    expect(atTask.anchors).toEqual(['NewTask.title', 'Tracker.newTask', 'Tracker.create', 'Nav.tasks']);
  });
});

describe('workingNow exact task.id confirmation & negative controls', () => {
  const staffedOrg = (employeePatch: Partial<Employee> = {}) =>
    makeOrg([OPERATIONS, makeDept({ id: 'd1', employees: [makeEmployee(employeePatch)] })]);

  it('does NOT celebrate on 201 alone, empty/delayed org, queued, unavailable, or another task working', () => {
    const myTask = makeTask({ id: 't-first', status: 'working' });
    const otherTask = makeTask({ id: 't-other', number: 2, status: 'working' });

    /* 201 alone: task.status === 'working' without employee workingNow on exact id -> still 'created'. */
    const createdOnly = deriveGuideState(makeSnap({
      record: makeRecord({ departmentId: 'd1', goalId: 'g1', taskId: 't-first' }),
      org: staffedOrg({ status: 'idle', task: null }),
      goals: [makeGoal()],
      tasks: [myTask],
    }));
    expect(createdOnly.step).toBe('work');
    expect(createdOnly.phase).toBe('created');
    expect(createdOnly.workConfirmed).toBe(false);

    /* Delayed org (null) -> created, never celebrated. */
    const delayedOrg = deriveGuideState(makeSnap({
      record: makeRecord({ departmentId: 'd1', goalId: 'g1', taskId: 't-first' }),
      org: null,
      goals: [makeGoal()],
      tasks: [myTask],
    }));
    expect(delayedOrg.phase).toBe('created');
    expect(delayedOrg.workConfirmed).toBe(false);

    /* Confirmed queued status on exact task.id -> queued, not working. */
    const queued = deriveGuideState(makeSnap({
      record: makeRecord({ departmentId: 'd1', goalId: 'g1', taskId: 't-first' }),
      org: staffedOrg({ status: 'queued', task: { id: 't-first', number: 1, title: 'Draft', echelons: {} as never } }),
      goals: [makeGoal()],
      tasks: [myTask],
    }));
    expect(queued.phase).toBe('queued');
    expect(queued.workConfirmed).toBe(false);

    /* Status source failure -> unavailable, never celebrated. */
    const unavailable = deriveGuideState(makeSnap({
      record: makeRecord({ departmentId: 'd1', goalId: 'g1', taskId: 't-first' }),
      org: staffedOrg({ status: 'idle', task: null }),
      tasksFailure: new Error('network'),
      goals: [makeGoal()],
      tasks: [myTask],
    }));
    expect(unavailable.phase).toBe('unavailable');
    expect(unavailable.workConfirmed).toBe(false);

    /* Negative control: another task ID is working in workingNow -> MUST NOT confirm t-first! */
    const otherWorkingOrg = staffedOrg({
      status: 'working',
      task: { id: 't-other', number: 2, title: 'Other', echelons: {} as never },
    });
    expect(hasConfirmedWorkStart('t-first', [myTask, otherTask], otherWorkingOrg)).toBe(false);
    expect(hasConfirmedWorkStart('t-other', [myTask, otherTask], otherWorkingOrg)).toBe(true);
    const otherWorking = deriveGuideState(makeSnap({
      record: makeRecord({ departmentId: 'd1', goalId: 'g1', taskId: 't-first' }),
      org: otherWorkingOrg,
      goals: [makeGoal()],
      tasks: [myTask, otherTask],
    }));
    expect(otherWorking.phase).toBe('created');
    expect(otherWorking.workConfirmed).toBe(false);

    /* Paused task enters recovery, never celebrated. */
    const paused = deriveGuideState(makeSnap({
      record: makeRecord({ departmentId: 'd1', goalId: 'g1', taskId: 't-first' }),
      org: staffedOrg({ status: 'idle', task: null }),
      goals: [makeGoal()],
      tasks: [makeTask({ id: 't-first', paused: { reason: 'hold', by: 'p1', at: '2026-11-21T14:00:00Z' } as never })],
    }));
    expect(paused.phase).toBe('recovery');
    expect(paused.workConfirmed).toBe(false);
  });

  it('confirms once on workingNow matching exact task.id, even while skipped, and stays confirmed after task finishes', () => {
    const myTask = makeTask({ id: 't-first', status: 'working' });
    const workingOrg = staffedOrg({
      status: 'working',
      task: { id: 't-first', number: 1, title: 'Draft', echelons: {} as never },
    });
    expect(hasConfirmedWorkStart('t-first', [myTask], workingOrg)).toBe(true);

    /* Even while skipped, workConfirmed latches to true. */
    const whileSkipped = deriveGuideState(makeSnap({
      record: makeRecord({ skipped: true, departmentId: 'd1', goalId: 'g1', taskId: 't-first' }),
      org: workingOrg,
      goals: [makeGoal()],
      tasks: [myTask],
    }));
    expect(whileSkipped.step).toBe('work');
    expect(whileSkipped.phase).toBe('working');
    expect(whileSkipped.workConfirmed).toBe(true);

    /* Once latched, moving task to done preserves final summary for that exact task. */
    const afterDone = deriveGuideState(makeSnap({
      record: makeRecord({ departmentId: 'd1', goalId: 'g1', taskId: 't-first', workConfirmed: true }),
      org: staffedOrg({ status: 'idle', task: null }),
      goals: [makeGoal()],
      tasks: [makeTask({ id: 't-first', status: 'done' })],
    }));
    expect(afterDone.step).toBe('work');
    expect(afterDone.phase).toBe('working');
    expect(afterDone.workConfirmed).toBe(true);
  });
});

describe('storage — minimal fields, zero secrets, and (origin, company, person) isolation', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('stores only visibility before setup, transfers handoff cleanly, and isolates companies & people', () => {
    savePreSetupGuide(true);
    expect(loadPreSetupGuide()).toEqual({ version: 1, skipped: true });
    expect(Object.keys(JSON.parse(localStorage.getItem('hh-guide-pre-v1')!)).sort()).toEqual(['skipped', 'version']);

    recordSetupHandoff('personal');
    const rec = consumeSetupHandoff({ origin: 'https://a.example', companyId: 'c1', personId: 'p1' });
    expect(rec).toMatchObject({ version: 1, active: true, skipped: true, mode: 'personal', workConfirmed: false });
    /* Pre-setup and temporary handoff keys are removed after transfer. */
    expect(localStorage.getItem('hh-guide-pre-v1')).toBeNull();
    expect(localStorage.getItem('hh-guide-handoff-v1')).toBeNull();

    saveGuideRecord({ origin: 'https://a.example', companyId: 'c1', personId: 'p1' }, { ...rec!, taskId: 't1', workConfirmed: true });

    /* Another person or company or origin sees no leaked guide state. */
    expect(loadGuideRecord({ origin: 'https://a.example', companyId: 'c1', personId: 'p2' })).toBeNull();
    expect(loadGuideRecord({ origin: 'https://a.example', companyId: 'c2', personId: 'p1' })).toBeNull();
    expect(loadGuideRecord({ origin: 'https://b.example', companyId: 'c1', personId: 'p1' })).toBeNull();
    /* Same identity reloads saved state. */
    expect(loadGuideRecord({ origin: 'https://a.example', companyId: 'c1', personId: 'p1' })).toMatchObject({ taskId: 't1', workConfirmed: true });

    /* Stored payload has strictly minimal schema (no secrets, commands, or drafts). */
    const raw = localStorage.getItem('hh-guide-v1:https://a.example:c1:p1')!;
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      'active', 'departmentId', 'done', 'goalId', 'mode', 'skipped', 'taskId', 'version', 'workConfirmed',
    ]);
    clearPreSetupGuide();
  });
});

describe('voices — theme separation, Egypt voice, custom skin fallback, zero hardcoded hex colors', () => {
  it('resolves exact Cyberpunk and Egypt voices in EN and RU, with no forbidden vocabulary or Back to Cyberpunk text', () => {
    for (const step of GUIDE_STEPS) {
      const cpEn = resolveGuideVoice('cyberpunk', 'en', step, en);
      const cpRu = resolveGuideVoice('cyberpunk', 'ru', step, ru);
      const egEn = resolveGuideVoice('egypt', 'en', step, en);
      const egRu = resolveGuideVoice('egypt', 'ru', step, ru);
      expect(cpEn).toHaveLength(3);
      expect(egEn).toHaveLength(3);
      expect(cpEn[0]).not.toBe(egEn[0]);
      expect(cpRu[0]).not.toBe(egRu[0]);
      for (const line of [...cpEn, ...egEn]) {
        expect(line).not.toMatch(/—|chief|back to cyberpunk/i);
      }
      for (const line of [...cpRu, ...egRu]) {
        expect(line).not.toMatch(/[ёЁ—]|узел|узл|компьютер|шеф|вернуться к киберпанку/i);
      }
    }
    expect(resolveGuideVoice('egypt', 'en', 'company', en)[0]).toBe('Yes, master. What name shall we put in the company records?');
    expect(resolveGuideVoice('egypt', 'ru', 'company', ru)[0]).toBe('Да, хозяин. Какое имя запишем в книгу компании?');
    expect(resolveGuideVoice('egypt', 'en', 'work', en)[1]).toBe('Yes, master. An employee has begun your first task.');
    expect(resolveGuideVoice('egypt', 'ru', 'work', ru)[1]).toBe('Да, хозяин. Сотрудник уже взялся за вашу первую задачу.');
    expect(guideCompanionKind('cyberpunk')).toBe('signal');
    expect(guideCompanionKind('egypt')).toBe('reed');
  });

  it('supports custom theme voice packs without modifying steps and falls back to full standard voice for missing lines', () => {
    const unregister = registerGuideVoice('custom-noir', {
      en: {
        company: ['Noir line for company.', '', ''],
      },
    });
    try {
      const companyVoice = resolveGuideVoice('custom-noir', 'en', 'company', en);
      expect(companyVoice[0]).toBe('Noir line for company.');
      expect(companyVoice[1]).toBe(en.guide.voices.company[1]);
      expect(companyVoice[2]).toBe(en.guide.voices.company[2]);
      expect(resolveGuideVoice('custom-noir', 'en', 'account', en)).toEqual(en.guide.voices.account);
      expect(resolveGuideVoice('custom-noir', 'ru', 'company', ru)).toEqual(ru.guide.voices.company);
      expect(resolveGuideVoice('unknown-skin', 'en', 'goal', en)).toEqual(en.guide.voices.goal);
    } finally {
      unregister();
    }
  });

  it('contains zero hardcoded palette hex colors anywhere in apps/web/src/guide', () => {
    const dir = resolve(process.cwd(), 'src/guide');
    const files = readdirSync(dir).filter(f => /\.(ts|tsx|css)$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(resolve(dir, file), 'utf8');
      expect(content, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});

describe('placement — inline-end -> inline-start -> inline, RTL mirroring, safeTop, viewport hiding', () => {
  const viewport = { left: 0, top: 0, width: 1440, height: 900 };
  const card = { width: 320, height: 180 };

  it('places at logical inline-end on 1440px LTR and mirrors to left on RTL', () => {
    const anchor = { left: 400, right: 860, top: 200, bottom: 244, width: 460, height: 44 };
    const ltr = computeCoachPlacement({ anchor, frame: anchor, viewport, card, dir: 'ltr', safeTop: 72, coachFocused: false });
    expect(ltr).toEqual({ mode: 'floating', hidden: false, side: 'end', left: 872, top: 200 });

    const rtl = computeCoachPlacement({ anchor, frame: anchor, viewport, card, dir: 'rtl', safeTop: 72, coachFocused: false });
    expect(rtl).toEqual({ mode: 'floating', hidden: false, side: 'end', left: 68, top: 200 });
  });

  it('flips to inline-start when inline-end has no room and clamps top below safeTop', () => {
    const nearRight = { left: 900, right: 1300, top: 30, bottom: 74, width: 400, height: 44 };
    const placed = computeCoachPlacement({ anchor: nearRight, frame: nearRight, viewport, card, dir: 'ltr', safeTop: 72, coachFocused: false });
    expect(placed).toEqual({ mode: 'floating', hidden: false, side: 'start', left: 568, top: 72 });
  });

  it('falls back to inline on 375px mobile or narrow panel, and hides floating card when scrolled out of view', () => {
    const anchor = { left: 16, right: 359, top: 120, bottom: 164, width: 343, height: 44 };
    const mobile = computeCoachPlacement({ anchor, frame: anchor, viewport: { left: 0, top: 0, width: 375, height: 812 }, card, dir: 'ltr', safeTop: 68, coachFocused: false });
    expect(mobile.mode).toBe('inline');
    expect(mobile.hidden).toBe(false);

    const narrowPanel = computeCoachPlacement({ anchor: { left: 400, right: 660, top: 200, bottom: 244, width: 260, height: 44 }, frame: { left: 400, right: 660, top: 100, bottom: 500, width: 260, height: 400 }, viewport, card, dir: 'ltr', safeTop: 72, coachFocused: false });
    expect(narrowPanel.mode).toBe('inline');

    const offscreen = computeCoachPlacement({ anchor: { left: 400, right: 860, top: -80, bottom: -20, width: 460, height: 60 }, frame: { left: 400, right: 860, top: -80, bottom: 400, width: 460, height: 480 }, viewport, card, dir: 'ltr', safeTop: 72, coachFocused: false });
    expect(offscreen.hidden).toBe(true);
  });

  it('picks safe permitted navigation routes on Resume guide', () => {
    expect(resumeTargetRoute(deriveGuideState(makeSnap({
      record: makeRecord({ mode: 'personal' }),
      org: makeOrg([OPERATIONS], makeSub({ status: 'waiting_machine', online: false, machines: [] })),
      subs: [makeSub({ status: 'waiting_machine', online: false, machines: [] })],
    })))).toEqual({ kind: 'machines' });

    const dept = makeDept({ id: 'd1', employees: [makeEmployee()] });
    expect(resumeTargetRoute(deriveGuideState(makeSnap({
      org: makeOrg([OPERATIONS, dept]),
      goals: [],
    })))).toEqual({ kind: 'tasks', department: 'd1' });
  });
});
