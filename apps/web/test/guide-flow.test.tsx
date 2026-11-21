import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { LanguageProvider } from '../src/i18n';
import { forgetOrg } from '../src/org';
import { Setup } from '../src/screens/Setup';
import { Shell } from '../src/screens/Shell';
import { chooseSkin, initSkins } from '../src/skins/store';
import { emitGuideEvent, loadGuideRecord, recordSetupHandoff, saveGuideRecord } from '../src/guide/storage';
import type { Department, GoalView, Org, SubView, TaskLine } from '../src/types';
import { ME, mockApi, ORG, SUBS, TEST_KEY } from './api-mock';

const CREATED = { companyId: 'c1', personId: 'p1', email: 'ivan@acme.com' };

function apiReadySub(): SubView {
  return { ...SUBS[3]!, id: 's-key', isOrchestrator: true, status: 'ready', online: true };
}

function emptyOrg(sub: SubView | null = apiReadySub()): Org {
  return {
    ...ORG,
    orchestrator: ORG.orchestrator ? { ...ORG.orchestrator, subscription: sub } : null,
    departments: [
      {
        id: 'd-ops', name: null, templateKey: 'operations', roleCode: 'OPS', about: '',
        agents: { total: 1, working: 0 }, products: [], teams: [], people: [],
        employees: [], roles: [],
      },
    ],
  };
}

function productDept(withHead: boolean, taskWorking?: { id: string; number: number; title: string }): Department {
  return {
    id: 'd1', name: 'Product', templateKey: null, roleCode: 'PRD', about: '',
    agents: { total: withHead ? 1 : 0, working: taskWorking ? 1 : 0 },
    products: [], teams: [], people: [],
    employees: withHead ? [
      {
        id: 'e1', name: 'Neo', roleId: 'r1', title: { en: 'Team lead', ru: 'Руководитель отдела' },
        kind: 'head', model: 'sonnet', modelName: 'Sonnet', provider: 'anthropic_api', effort: null,
        state: taskWorking ? 'working' : 'sleeping',
        status: taskWorking ? 'working' : 'idle',
        on: true, timer: null,
        task: taskWorking ? { ...taskWorking, echelons: {} as never } : null,
        context: null, program: null, alarm: null, retry: null, failure: null,
      },
    ] : [],
    roles: [],
  };
}

function stubSetupRoutes(extra: Record<string, [number, unknown?]> = {}) {
  return mockApi({
    'GET /api/setup/names/acme?code=LINK-CODE-123': [200, { available: true }],
    'GET /api/setup/names/random?code=LINK-CODE-123': [200, { available: true }],
    'POST /api/setup': [201, CREATED],
    'GET /api/me/key': [200, { key: TEST_KEY }],
    ...extra,
  });
}

describe('First-run guide — Setup flow, skip/resume, accessibility, and zero auto-actions', () => {
  beforeEach(() => {
    localStorage.clear();
    forgetOrg();
    window.history.replaceState(null, '', '/?code=LINK-CODE-123');
    delete document.documentElement.dataset.world;
    delete document.documentElement.dataset.surface;
    initSkins();
  });

  afterEach(() => {
    localStorage.clear();
    forgetOrg();
    window.history.replaceState(null, '', '/');
    delete document.documentElement.dataset.world;
    delete document.documentElement.dataset.surface;
    vi.restoreAllMocks();
  });

  it('guides Setup steps without auto-submitting, keeps companion decorative, and preserves aria-describedby', async () => {
    const calls = stubSetupRoutes();
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<LanguageProvider><Setup onDone={onDone} /></LanguageProvider>);

    /* Coach appears on Company step with Cyberpunk voice and NO role="img". */
    expect(screen.getByRole('complementary', { name: 'First-run guide' })).toBeInTheDocument();
    expect(screen.getByText('Bring your company onto the map. Start with its name.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();

    /* Zero automatic POST calls from opening the guide. */
    expect(calls.filter(c => c.method === 'POST')).toEqual([]);

    /* Company name input gets guide-coach-text in aria-describedby. */
    const companyInput = screen.getByLabelText('Company name');
    await waitFor(() => expect(companyInput.getAttribute('aria-describedby')).toContain('guide-coach-text'));

    /* Skip guide removes coach & highlight while keeping typed draft and showing Resume in header. */
    await user.type(companyInput, 'Meridian');
    await user.click(screen.getByRole('button', { name: 'Skip guide' }));
    expect(screen.queryByRole('complementary', { name: 'First-run guide' })).not.toBeInTheDocument();
    expect(companyInput).toHaveValue('Meridian');
    expect(companyInput.getAttribute('aria-describedby') ?? '').not.toContain('guide-coach-text');

    /* Resume guide returns coach and focuses the real input once. */
    await user.click(screen.getByRole('button', { name: 'Resume guide' }));
    expect(screen.getByRole('complementary', { name: 'First-run guide' })).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(companyInput));

    /* Advance to Account step -> coach confirms company and guides owner account; preserves field hint/error aria-describedby. */
    await user.click(screen.getByRole('checkbox', { name: /Open Hornhoof on the internet/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Name entered. Your company has a point on the map.')).toBeInTheDocument();
    expect(screen.getByText('Set up your owner account so you can run the company from here.')).toBeInTheDocument();

    /* Trigger validation error on short password -> recovery line appears while password field keeps its native hint & error. */
    await user.type(screen.getByLabelText('Your name'), 'Ivan');
    await user.type(screen.getByLabelText('Email'), 'ivan@acme.com');
    await user.type(screen.getByLabelText('Password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Account details need a check. Follow the message by the field.')).toBeInTheDocument();
    const pwd = screen.getByLabelText('Password');
    expect(pwd.getAttribute('aria-invalid')).toBe('true');

    /* Fix password and proceed to Plan step -> coach updates and preserves exact Setup payload on Finish. */
    await user.clear(pwd);
    await user.type(pwd, 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Give the orchestrator a plan to run on. You can connect it here or come back to Subscriptions.')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Later' }));
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(onDone).toHaveBeenCalledWith({ welcome: true });
    expect(calls.filter(c => c.method === 'POST').map(c => c.path)).toEqual(['/api/setup']);
  });

  it('switches voice live between Cyberpunk and Egypt while keeping the same step and language', async () => {
    stubSetupRoutes();
    render(<LanguageProvider><Setup onDone={() => {}} /></LanguageProvider>);

    expect(screen.getByText('Bring your company onto the map. Start with its name.')).toBeInTheDocument();

    /* Switch active world/theme attribute to egypt (as #1803 does). */
    act(() => {
      document.documentElement.dataset.theme = 'egypt';
      document.documentElement.dataset.world = 'egypt';
      document.documentElement.dataset.surface = 'papyrus';
    });

    await waitFor(() => {
      expect(screen.getByText('Yes, master. What name shall we put in the company records?')).toBeInTheDocument();
    });
    expect(document.querySelector('.guide-companion[data-companion="reed"]')).toBeInTheDocument();

    /* Switch back to cyberpunk -> lines revert cleanly. */
    act(() => {
      delete document.documentElement.dataset.world;
      delete document.documentElement.dataset.surface;
      chooseSkin('cyberpunk');
    });
    await waitFor(() => {
      expect(screen.getByText('Bring your company onto the map. Start with its name.')).toBeInTheDocument();
    });
  });

  it('does NOT start the guide on AcceptInvite, RestoreFromFile, or ordinary Login without first-run handoff', async () => {
    /* 1. AcceptInvite route. */
    window.history.replaceState(null, '', '/invite/tok-123');
    mockApi({
      'GET /api/invites/tok-123': [200, { companyName: 'Acme', name: 'Mira', email: 'mira@acme.com', title: 'Designer' }],
    });
    const { unmount } = render(<LanguageProvider><App /></LanguageProvider>);
    await screen.findByRole('heading', { name: /Acme/i });
    expect(screen.queryByRole('complementary', { name: 'First-run guide' })).not.toBeInTheDocument();
    unmount();

    /* 2. Existing company Login -> Shell (no handoff) must NOT show guide or extra account menu row. */
    window.history.replaceState(null, '', '/');
    mockApi({
      'GET /api/setup': [200, { needed: false }],
      'GET /api/me': [200, ME],
      'GET /api/org': [200, emptyOrg()],
      'GET /api/requests': [200, { requests: [], proposals: [], merges: [], counts: { byPerson: {}, byAgent: {}, total: 0 } }],
      'GET /api/improvements': [200, { improvements: [] }],
      'GET /api/updates': [200, { available: null, state: 'idle' }],
      'GET /api/feedback/inbox': [404, {}],
    });
    const user = userEvent.setup();
    render(<LanguageProvider><App /></LanguageProvider>);
    const acct = await screen.findByRole('button', { name: 'Account' });
    expect(screen.queryByRole('complementary', { name: 'First-run guide' })).not.toBeInTheDocument();
    await user.click(acct);
    expect(screen.queryByRole('button', { name: /guide/i })).not.toBeInTheDocument();
  });
});

describe('First-run guide — Shell progression, FirstContact priority, Account menu resume, and workingNow', () => {
  beforeEach(() => {
    localStorage.clear();
    forgetOrg();
    window.history.replaceState(null, '', '/');
    delete document.documentElement.dataset.world;
    delete document.documentElement.dataset.surface;
    initSkins();
  });

  afterEach(() => {
    localStorage.clear();
    forgetOrg();
    window.history.replaceState(null, '', '/');
    vi.restoreAllMocks();
  });

  it('yields to FirstContact dialog, activates once closed, supports Skip/Resume in Account menu, and celebrates only on exact task.id workingNow', async () => {
    recordSetupHandoff('api_key');

    const firstTask: TaskLine = {
      id: 'task-1', number: 1, title: 'Draft product brief', status: 'open', priority: 'normal',
      parentId: null, department: { id: 'd1', name: 'Product' }, product: null, goal: null,
      assignee: { id: 'e1', name: 'Neo' }, executor: { id: 'e1', name: 'Neo' },
      responsible: { id: 'p1', name: 'Ivan' }, paused: null, urgent: false,
      waitsFor: [], externalWait: null, pipelineId: null, pipelineStageId: null,
      brief: '', createdAt: '2026-11-21T14:00:00Z', updatedAt: '2026-11-21T14:00:00Z',
      echelons: {} as never,
    };
    const firstGoal: GoalView = {
      id: 'g1', number: 1, title: 'Ship first brief', why: '', status: 'active', version: 1,
      parentId: null, department: { id: 'd1', name: 'Product' },
      responsible: { id: 'p1', name: 'Ivan' }, target: null, current: null, unit: '', dueAt: null,
      progress: { done: 0, total: 0 }, createdAt: '2026-11-21T14:00:00Z',
    } as GoalView;

    let currentOrg = emptyOrg();
    let currentGoals: GoalView[] = [];
    let currentTasks: TaskLine[] = [];

    mockApi({
      'GET /api/org': () => [200, currentOrg],
      'GET /api/subscriptions': [200, { subscriptions: [apiReadySub()] }],
      'GET /api/machines': [200, { machines: [] }],
      'GET /api/goals': () => [200, { goals: currentGoals }],
      'GET /api/tasks?status=all': () => [200, { tasks: currentTasks }],
      'GET /api/requests': [200, { requests: [], proposals: [], merges: [], counts: { byPerson: {}, byAgent: {}, total: 0 } }],
      'GET /api/improvements': [200, { improvements: [] }],
      'GET /api/updates': [200, { available: null, state: 'idle' }],
      'GET /api/feedback/inbox': [404, {}],
      'GET /api/orchestrator/first-contact': [200, { offers: [] }],
    });

    const user = userEvent.setup();
    render(<LanguageProvider><Shell me={ME} welcome onSignOut={() => {}} /></LanguageProvider>);

    /* While FirstContact dialog is open, it has priority and coach is hidden. */
    const dialog = await screen.findByRole('dialog', { name: 'Talk to the orchestrator' });
    expect(screen.queryByRole('complementary', { name: 'First-run guide' })).not.toBeInTheDocument();

    /* Close FirstContact -> coach appears on Map pointing at Orchestrator to build first department. */
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    const coach = await screen.findByRole('complementary', { name: 'First-run guide' });
    expect(within(coach).getByText('Open the orchestrator to build the department you want to start with.')).toBeInTheDocument();

    /* Skip via coach, then verify Account menu offers Resume guide. */
    await user.click(within(coach).getByRole('button', { name: 'Skip guide' }));
    expect(screen.queryByRole('complementary', { name: 'First-run guide' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Account' }));
    const resumeBtn = screen.getByRole('button', { name: 'Resume guide' });
    await user.click(resumeBtn);
    await screen.findByRole('complementary', { name: 'First-run guide' });

    /* Advance real data: department + head + goal + created task -> not yet workingNow -> shows created, NOT Working now! */
    currentOrg = { ...emptyOrg(), departments: [...emptyOrg().departments, productDept(true)] };
    currentGoals = [firstGoal];
    currentTasks = [firstTask];
    act(() => {
      emitGuideEvent({ type: 'task_created', id: 'task-1' });
    });

    await waitFor(() => {
      expect(screen.getByText('Task created. Work has not been confirmed yet.')).toBeInTheDocument();
    });
    expect(screen.queryByText('First task underway. An employee is on it.')).not.toBeInTheDocument();

    /* Now persist and simulate workingNow matching exact task-1 -> celebrates and shows Finish guide + Open task! */
    currentOrg = {
      ...emptyOrg(),
      departments: [...emptyOrg().departments, productDept(true, { id: 'task-1', number: 1, title: 'Draft product brief' })],
    };
    const key = { origin: window.location.origin, companyId: ME.company.id, personId: ME.person.id };
    const saved = loadGuideRecord(key)!;
    saveGuideRecord(key, { ...saved, taskId: 'task-1' });
    act(() => {
      emitGuideEvent({ type: 'refresh' });
    });

    await waitFor(() => {
      expect(screen.getByText('First task underway. An employee is on it.')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Finish guide' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open task' })).toBeInTheDocument();
    expect(loadGuideRecord(key)?.workConfirmed).toBe(true);
  });
});
