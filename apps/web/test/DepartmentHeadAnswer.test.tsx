import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { LanguageProvider } from '../src/i18n';
import { forgetOrg, useOrg } from '../src/org';
import { AgentWindows, useAgentWindows } from '../src/screens/AgentWindows';
import { pruneSwitched } from '../src/screens/Department';
import { Shell } from '../src/screens/Shell';
import { forgetRequestDrafts } from '../src/ui/Requests';
import type { AgentCardView, Department, Employee, Me, Org } from '../src/types';
import { CARD, DEV_ORG, REQUESTS, TASK_DETAIL, TASKS, TURN, decisions, mockApi } from './api-mock';
import { fakeStream } from './fake-stream';

const STATE = { ready: true, reason: null, busy: false, runningJobId: null, queued: 0, terminal: false, canType: true, turnRefused: null };
const EVENTS_REPLY: [number, unknown] = [
  200,
  {
    events: [{ seq: 1, kind: 'text', data: { text: 'Need your decision on the provider.' }, jobId: 'j1', person: null, at: '2026-10-30T09:05:00.000Z' }],
    state: STATE,
  },
];

const DEPT_OWNER_ME: Me = {
  person: { id: 'p-leo', companyId: 'c1', name: 'Leo', email: 'leo@moonfern.example', title: 'CMO', status: 'active', scopeKind: 'listed', isOwner: false },
  company: { id: 'c1', name: 'Moonfern' },
  canDecideCompany: false,
};

function largeRestrictedOrg(): { org: Org; headId: string; allAgentIds: string[] } {
  const allAgentIds: string[] = [];
  const departments: Department[] = Array.from({ length: 12 }, (_, d) => {
    const deptId = `dept-${d + 1}`;
    const own = d === 0;
    const employees: Employee[] = Array.from({ length: 10 }, (__, i) => {
      const id = `ag-${d + 1}-${i + 1}`;
      allAgentIds.push(id);
      return {
        id,
        name: `Agent ${d + 1}.${i + 1}`,
        roleId: i === 0 ? `r-${d}-head` : `r-${d}-m`,
        title: i === 0 ? { en: 'Head', ru: 'Глава' } : { en: 'Specialist', ru: 'Специалист' },
        kind: i === 0 ? 'head' : 'worker',
        model: 'claude-sonnet-5-5',
        modelName: 'Claude Sonnet 5.5',
        provider: 'claude',
        effort: null,
        state: 'working',
        status: 'working',
        on: true,
        timer: null,
        task: null,
        context: 0.35,
        program: null,
        alarm: null,
        retry: null,
        failure: null,
        opens: own,
      };
    });
    return {
      id: deptId,
      name: `Department ${d + 1}`,
      templateKey: null,
      roleCode: `D${d + 1}`,
      about: '',
      ownerPersonId: own ? DEPT_OWNER_ME.person.id : null,
      agents: { total: 10, working: 10 },
      products: [],
      teams: [],
      people: own
        ? [{
          id: DEPT_OWNER_ME.person.id,
          name: DEPT_OWNER_ME.person.name,
          email: DEPT_OWNER_ME.person.email,
          title: DEPT_OWNER_ME.person.title,
          status: 'active',
          isOwner: false,
          access: { whole: false, departments: [{ id: deptId, name: `Department ${d + 1}` }], teams: [] },
        }]
        : [],
      employees,
      roles: [
        { id: `r-${d}-head`, title: { en: 'Head', ru: 'Глава' }, description: { en: '', ru: '' }, kind: 'head', gate: null },
        { id: `r-${d}-m`, title: { en: 'Specialist', ru: 'Специалист' }, description: { en: '', ru: '' }, kind: 'member', gate: 0 },
      ],
    };
  });
  return {
    headId: 'ag-1-1',
    allAgentIds,
    org: {
      company: DEPT_OWNER_ME.company,
      orchestrator: {
        id: 'a1',
        name: 'Orchestrator',
        model: 'claude-opus-5-5',
        effort: null,
        subscription: null,
        context: 0.2,
        program: null,
        alarm: null,
        retry: null,
        failure: null,
        opens: false,
      },
      agents: { total: 120, working: 120 },
      people: [],
      departments,
    },
  };
}

function LiveDepartmentWindow({ headId }: { headId: string }) {
  const { org } = useOrg(true);
  const windows = useAgentWindows(headId);
  return (
    <LanguageProvider>
      <AgentWindows windows={windows} onOpen={() => {}} me={DEPT_OWNER_ME} org={org} staff={null} requests={[]} onRequestsChanged={() => {}} />
    </LanguageProvider>
  );
}

describe('department owner answering head on a large company', () => {
  beforeEach(() => {
    forgetOrg();
    forgetRequestDrafts();
    localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    forgetOrg();
    forgetRequestDrafts();
    localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('shows the department canvas instead of a blank grey body while the initial organization response is still in flight', async () => {
    let releaseOrg!: () => void;
    const heldOrg = new Promise<void>(resolve => {
      releaseOrg = resolve;
    });
    const deptOrg: Org = {
      ...DEV_ORG,
      departments: DEV_ORG.departments.map(d => ({
        ...d,
        ownerPersonId: DEPT_OWNER_ME.person.id,
        people: [{
          id: DEPT_OWNER_ME.person.id,
          name: DEPT_OWNER_ME.person.name,
          email: DEPT_OWNER_ME.person.email,
          title: DEPT_OWNER_ME.person.title,
          status: 'active',
          isOwner: false,
          access: { whole: false, departments: [{ id: 'd2', name: 'Development' }], teams: [] },
        }],
      })),
    };
    mockApi({
      'GET /api/org': async () => {
        await heldOrg;
        return [200, deptOrg];
      },
      'GET /api/requests': [200, decisions([])],
      'GET /api/turns': [200, { turns: [TURN] }],
      'GET /api/task-departments': [200, { whole: false, departments: [{ id: 'd2', name: 'Development', templateKey: 'development' }] }],
    });
    window.history.replaceState(null, '', '/departments/d2');
    render(
      <LanguageProvider>
        <Shell me={DEPT_OWNER_ME} onSignOut={() => {}} />
      </LanguageProvider>,
    );

    expect(document.querySelector('main.body .dview[aria-busy="true"] .dcanvas')).not.toBeNull();

    releaseOrg();
    expect(await screen.findByText('Dana')).toBeInTheDocument();
  });

  it('does not storm GET /api/agents/:id on 120-agent context ticks or unmount an open window on a transient re-check error', async () => {
    const stream = fakeStream();
    const { org, headId, allAgentIds } = largeRestrictedOrg();
    const headCard: AgentCardView = {
      ...CARD,
      id: headId,
      kind: 'head',
      name: 'Agent 1.1',
      department: { id: 'dept-1', name: 'Department 1' },
    };
    let agentReply: [number, unknown] = [200, headCard];
    const calls = mockApi({
      'GET /api/org': [200, org],
      [`GET /api/agents/${headId}`]: () => agentReply,
      [`GET /api/agents/${headId}/events?last=300`]: EVENTS_REPLY,
      [`GET /api/agents/${headId}/events?after=1`]: [200, { events: [], state: STATE }],
      'GET /api/departments/dept-1/notes': [200, { notes: [] }],
    });

    render(<LiveDepartmentWindow headId={headId} />);
    await waitFor(() => expect(document.getElementById(`input-${headId}`)).not.toBeNull());
    const input = document.getElementById(`input-${headId}`) as HTMLTextAreaElement;
    const windowEl = document.querySelector('aside.orch');
    expect(windowEl).not.toBeNull();

    input.focus();
    fireEvent.change(input, { target: { value: 'Draft answer to my head' } });
    expect(document.activeElement).toBe(input);

    await waitFor(() => expect(calls.filter(c => c.path === `/api/agents/${headId}`).length).toBeGreaterThanOrEqual(2));
    const beforeContext = calls.filter(c => c.path === `/api/agents/${headId}`).length;

    for (const id of allAgentIds.slice(0, 24)) {
      stream.send({ type: 'context', agentId: id, used: 0.62 });
    }
    expect(calls.filter(c => c.path === `/api/agents/${headId}`)).toHaveLength(beforeContext);
    expect(document.querySelector('aside.orch')).toBe(windowEl);
    expect(document.activeElement).toBe(input);

    agentReply = [503, { error: { code: 'unavailable', message: 'Server busy.' } }];
    const beforeTransient = calls.filter(c => c.path === `/api/agents/${headId}`).length;
    stream.send({ type: 'working', working: 88 });
    await waitFor(() => expect(calls.filter(c => c.path === `/api/agents/${headId}`).length).toBeGreaterThan(beforeTransient));

    expect(document.querySelector('aside.orch')).toBe(windowEl);
    expect((input as HTMLTextAreaElement).value).toBe('Draft answer to my head');
    expect(document.activeElement).toBe(input);

    agentReply = [403, { error: { code: 'forbidden', message: 'Hidden.' } }];
    stream.send({ type: 'org' });
    expect(await screen.findByRole('heading', { name: 'Insufficient permissions' })).toBeInTheDocument();
    expect(document.querySelector('aside.orch')).toBeNull();
  });

  it('keeps the open question card, task panel and chat draft intact when live stream refreshes hit cut-off 200 responses', async () => {
    const stream = fakeStream();
    const rejections: unknown[] = [];
    const onRejection = (event: PromiseRejectionEvent) => {
      event.preventDefault();
      rejections.push(event.reason);
    };
    window.addEventListener('unhandledrejection', onRejection);
    try {
      const headCard: AgentCardView = {
        ...CARD,
        id: 'b0',
        kind: 'head',
        name: 'Dana',
        currentTask: { id: 't9', number: 9, title: 'Pick a payment provider' },
      };
      const taskDetail = { ...TASK_DETAIL, ...TASKS[2]! };
      let cutOff = false;
      const deptOrg: Org = {
        ...DEV_ORG,
        orchestrator: { ...DEV_ORG.orchestrator!, opens: false },
        departments: DEV_ORG.departments.map(d => ({
          ...d,
          ownerPersonId: DEPT_OWNER_ME.person.id,
          employees: d.employees.map(e => ({ ...e, opens: true })),
          people: [{
            id: DEPT_OWNER_ME.person.id,
            name: DEPT_OWNER_ME.person.name,
            email: DEPT_OWNER_ME.person.email,
            title: DEPT_OWNER_ME.person.title,
            status: 'active',
            isOwner: false,
            access: { whole: false, departments: [{ id: 'd2', name: 'Development' }], teams: [] },
          }],
        })),
      };
      const question = { ...REQUESTS[0]!, ownerPersonId: DEPT_OWNER_ME.person.id, canAnswer: true };
      const calls = mockApi({
        'GET /api/org': () => (cutOff ? [200] : [200, deptOrg]),
        'GET /api/requests': () => (cutOff ? [200] : [200, decisions([question])]),
        'GET /api/turns': () => (cutOff ? [200] : [200, { turns: [TURN] }]),
        'GET /api/task-departments': [200, { whole: false, departments: [{ id: 'd2', name: 'Development', templateKey: 'development' }] }],
        'GET /api/tasks/t9': () => (cutOff ? [200] : [200, { task: taskDetail }]),
        'GET /api/agents/b0': () => (cutOff ? [200] : [200, headCard]),
        'GET /api/agents/b0/events?last=300': EVENTS_REPLY,
        'GET /api/agents/b0/events?after=1': () => (cutOff ? [200] : [200, { events: [], state: STATE }]),
        'GET /api/departments/d2/notes': () => (cutOff ? [200] : [200, { notes: [] }]),
      });

      window.history.replaceState(null, '', '/departments/d2');
      render(
        <LanguageProvider>
          <Shell me={DEPT_OWNER_ME} onSignOut={() => {}} />
        </LanguageProvider>,
      );

      fireEvent.click(await screen.findByRole('button', { name: /Dana/ }));
      await waitFor(() => expect(document.getElementById('input-b0')).not.toBeNull());
      const chatInput = document.getElementById('input-b0') as HTMLTextAreaElement;
      fireEvent.click(await screen.findByRole('button', { name: 'Task' }));
      expect(await screen.findByText('Stripe or Adyen?')).toBeInTheDocument();

      const answerInput = screen.getByLabelText('Your answer');
      fireEvent.change(answerInput, { target: { value: 'Use Stripe for EU' } });
      chatInput.focus();
      fireEvent.change(chatInput, { target: { value: 'Answering your question now' } });
      expect(document.activeElement).toBe(chatInput);

      cutOff = true;
      const beforeRequests = calls.filter(c => c.path === '/api/requests').length;
      const beforeTask = calls.filter(c => c.path === '/api/tasks/t9').length;
      const beforeCard = calls.filter(c => c.path === '/api/agents/b0').length;
      const beforeEvents = calls.filter(c => c.path === '/api/agents/b0/events?after=1').length;

      stream.send({ type: 'requests' });
      stream.send({ type: 'task' });
      stream.send({ type: 'reconnected' });

      await waitFor(() => {
        expect(calls.filter(c => c.path === '/api/requests').length).toBeGreaterThan(beforeRequests);
        expect(calls.filter(c => c.path === '/api/tasks/t9').length).toBeGreaterThan(beforeTask);
        expect(calls.filter(c => c.path === '/api/agents/b0').length).toBeGreaterThan(beforeCard);
        expect(calls.filter(c => c.path === '/api/agents/b0/events?after=1').length).toBeGreaterThan(beforeEvents);
      });

      expect(rejections).toEqual([]);
      expect(screen.getByText('Stripe or Adyen?')).toBeInTheDocument();
      expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe('Use Stripe for EU');
      expect((chatInput as HTMLTextAreaElement).value).toBe('Answering your question now');
      expect(document.activeElement).toBe(chatInput);
    } finally {
      window.removeEventListener('unhandledrejection', onRejection);
    }
  });

  it('shows the retry card instead of crashing #root when /api/me returns a cut-off or partial 200 response', async () => {
    mockApi({
      'GET /api/setup': [200, { needed: false }],
      'GET /api/me': [200, { person: { id: 'p-leo' } }],
    });

    const { container } = render(
      <LanguageProvider>
        <App />
      </LanguageProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'Hornhoof is not responding' }, { timeout: 1000 })).toBeInTheDocument();
    expect(container.childElementCount).toBeGreaterThan(0);
  });

  it('pauses hidden map SVG animations while a department workspace covers the map and resumes them on return', async () => {
    let paused = 0;
    let unpaused = 0;
    const proto = SVGSVGElement.prototype as SVGSVGElement & {
      pauseAnimations?: () => void;
      unpauseAnimations?: () => void;
    };
    const prevPause = proto.pauseAnimations;
    const prevUnpause = proto.unpauseAnimations;
    proto.pauseAnimations = () => {
      paused++;
    };
    proto.unpauseAnimations = () => {
      unpaused++;
    };
    try {
      const deptOrg: Org = {
        ...DEV_ORG,
        departments: DEV_ORG.departments.map(d => ({
          ...d,
          ownerPersonId: DEPT_OWNER_ME.person.id,
          people: [{
            id: DEPT_OWNER_ME.person.id,
            name: DEPT_OWNER_ME.person.name,
            email: DEPT_OWNER_ME.person.email,
            title: DEPT_OWNER_ME.person.title,
            status: 'active',
            isOwner: false,
            access: { whole: false, departments: [{ id: 'd2', name: 'Development' }], teams: [] },
          }],
        })),
      };
      mockApi({
        'GET /api/org': [200, deptOrg],
        'GET /api/requests': [200, decisions([])],
        'GET /api/turns': [200, { turns: [TURN] }],
        'GET /api/map/layout': [200, { blocks: {} }],
        'GET /api/task-departments': [200, { whole: false, departments: [{ id: 'd2', name: 'Development', templateKey: 'development' }] }],
      });

      window.history.replaceState(null, '', '/departments/d2');
      render(
        <LanguageProvider>
          <Shell me={DEPT_OWNER_ME} onSignOut={() => {}} />
        </LanguageProvider>,
      );

      expect(await screen.findByRole('region', { name: 'Department schema' })).toBeInTheDocument();
      expect(paused).toBeGreaterThan(0);
      expect(unpaused).toBe(0);

      fireEvent.click(screen.getByRole('button', { name: 'Back to the map' }));
      await waitFor(() => expect(unpaused).toBe(paused));
    } finally {
      proto.pauseAnimations = prevPause;
      proto.unpauseAnimations = prevUnpause;
    }
  });

  it('runs map signal dots without SMIL and pauses Web Animations on the hidden map behind a department', async () => {
    let paused = 0;
    let played = 0;
    let state: AnimationPlayState = 'running';
    const fakeAnim = {
      get playState() {
        return state;
      },
      pause() {
        state = 'paused';
        paused++;
      },
      play() {
        state = 'running';
        played++;
      },
    } as unknown as Animation;
    const elemProto = Element.prototype as Element & { getAnimations?: (opts?: GetAnimationsOptions) => Animation[] };
    const prevGetAnims = elemProto.getAnimations;
    elemProto.getAnimations = function () {
      return this instanceof HTMLElement && this.classList.contains('map') ? [fakeAnim] : [];
    };
    try {
      const activeOrg: Org = {
        ...DEV_ORG,
        agents: { total: 2, working: 1 },
        workLines: [{ upstreamAgentId: 'a1', downstreamAgentId: 'b0', working: true, workEpoch: 1, returnedEpoch: null, returnedAt: null }],
        departments: DEV_ORG.departments.map(d => ({
          ...d,
          ownerPersonId: DEPT_OWNER_ME.person.id,
          people: [{
            id: DEPT_OWNER_ME.person.id,
            name: DEPT_OWNER_ME.person.name,
            email: DEPT_OWNER_ME.person.email,
            title: DEPT_OWNER_ME.person.title,
            status: 'active',
            isOwner: false,
            access: { whole: false, departments: [{ id: 'd2', name: 'Development' }], teams: [] },
          }],
        })),
      };
      mockApi({
        'GET /api/org': [200, activeOrg],
        'GET /api/requests': [200, decisions([])],
        'GET /api/turns': [200, { turns: [TURN] }],
        'GET /api/map/layout': [200, { blocks: {} }],
        'GET /api/task-departments': [200, { whole: false, departments: [{ id: 'd2', name: 'Development', templateKey: 'development' }] }],
      });

      window.history.replaceState(null, '', '/departments/d2');
      const { container } = render(
        <LanguageProvider>
          <Shell me={DEPT_OWNER_ME} onSignOut={() => {}} />
        </LanguageProvider>,
      );

      expect(await screen.findByRole('region', { name: 'Department schema' })).toBeInTheDocument();
      /* The map behind it is drawn once its arrangement came too (#1620), which may be a moment after the department. */
      await waitFor(() => expect(container.querySelectorAll('.map circle.pt').length).toBeGreaterThan(0));
      expect(container.querySelectorAll('.map animateMotion')).toHaveLength(0);
      expect(paused).toBe(1);
      expect(played).toBe(0);

      fireEvent.click(screen.getByRole('button', { name: 'Back to the map' }));
      await waitFor(() => expect(played).toBe(1));
    } finally {
      elemProto.getAnimations = prevGetAnims;
    }
  });

  it('keeps the switched state reference until an employee toggle actually settles in the roster', () => {
    const employees = DEV_ORG.departments[0]!.employees;
    const empty: Record<string, boolean> = {};
    expect(pruneSwitched(empty, employees)).toBe(empty);

    const pending = { b0: false };
    expect(pruneSwitched(pending, employees)).toBe(pending);

    const mixed = { b0: true, b1: false };
    expect(pruneSwitched(mixed, employees)).toEqual({ b1: false });
  });
});
