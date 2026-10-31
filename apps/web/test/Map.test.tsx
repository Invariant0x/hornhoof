import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { orchestratorStatus, deptLayout, MapScreen } from '../src/screens/Map';
import type { SubView } from '../src/types';
import { LanguageProvider } from '../src/i18n';
import type { Department, Employee, Me } from '../src/types';
import { DEV_ORG, ME, mockApi, ORG, ORG_WITH_TEAMS, PEOPLE, SUBS } from './api-mock';
import { fakeStream } from './fake-stream';

const claude = SUBS[0]!;
const PROPS = { me: ME, windowOpen: false, onOpenOrchestrator: () => {} };
const DEPUTY: Me = { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } };

const dept = (d: Partial<Department> & { id: string }): Department => ({ name: null, templateKey: null, roleCode: 'SAL', about: '', agents: { total: 0, working: 0 }, products: [], teams: [], people: [], employees: [], roles: [], ...d });
const STATES: [string, SubView | null, string, string][] = [
  ['none', null, 'Needs a subscription to start', 'Чтобы начать, нужна подписка'],
  ['API key', SUBS[3]!, 'Ready, on the Anthropic key ending 9f3a', 'На связи, ключ Anthropic, последние символы 9f3a'],
  ['waiting for the machine', { ...claude, status: 'waiting_machine', online: false, machine: null }, "Waiting for Ivan's machine", 'Ждет машину, владелец Ivan'],
  ['needs login', { ...claude, status: 'needs_login' }, 'Waiting for the Claude login', 'Ждет входа в Claude'],
  ['ready and offline', { ...claude, online: false }, "Ivan's machine is offline", 'Машина не в сети, владелец Ivan'],
  ['ready and online', claude, "Ready, on Ivan's Claude subscription", 'На связи, подписка Claude, владелец Ivan'],
];

describe('orchestratorStatus', () => {
  it.each(STATES)('says where the orchestrator runs: %s', (_, sub, english, russian) => {
    expect(orchestratorStatus(en, sub)).toBe(english);
    expect(orchestratorStatus(ru, sub)).toBe(russian);
  });
});

describe('Map', () => {
  it('shows the orchestrator, the company people and the empty state on first run', async () => {
    mockApi({ 'GET /api/org': [200, ORG] });
    const { container } = render(<MapScreen {...PROPS} />);
    expect(await screen.findByText('No departments yet. Tell the orchestrator about the company and he will propose a structure.')).toBeInTheDocument();
    expect(container.querySelector('.hub-num')).toHaveTextContent('0/1');
    expect(screen.getByText('agents working')).toHaveClass('hub-lbl');
    expect(screen.getByText('Ivan')).toBeInTheDocument();
    expect(screen.getByText('Maria')).toBeInTheDocument();
    expect(container.querySelector('.ticker')).toHaveTextContent('OrchestratorReady, on the Anthropic key ending 9f3a');
  });

  it("shows how full the orchestrator's context is in the line at the bottom, and follows it live", async () => {
    const stream = fakeStream();
    mockApi({ 'GET /api/org': [200, { ...ORG, orchestrator: { ...ORG.orchestrator!, context: 0.34 } }] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Ivan');
    const ticker = container.querySelector<HTMLElement>('.ticker')!;
    expect(within(ticker).getByTitle('Context 34%')).toHaveTextContent('Context34%');
    stream.send({ type: 'context', agentId: 'a1', used: 0.71 });
    expect(within(ticker).getByTitle('Context 71%').querySelector('.bar')).toHaveClass('hi');
  });

  it('shows how hard the orchestrator thinks in the line at the bottom', async () => {
    mockApi({ 'GET /api/org': [200, { ...ORG, orchestrator: { ...ORG.orchestrator!, effort: 'xhigh' } }] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Ivan');
    expect(container.querySelector('.ticker')).toHaveTextContent('extra high effort');
  });

  it('shows the map again once the server answers after a failure', async () => {
    const stream = fakeStream();
    let up = false;
    mockApi({ 'GET /api/org': () => (up ? [200, ORG] : [500, { error: { code: 'internal', message: 'Down.' } }]) });
    render(<MapScreen {...PROPS} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    up = true;
    stream.send({ type: 'reconnected' });
    expect(await screen.findByText('agents working')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a deputy next to the CEO on the map', async () => {
    const oleg = { ...PEOPLE[2]!, id: 'p5', name: 'Oleg', title: '', access: { whole: false, departments: [{ id: 'd1', name: 'Marketing' }, { id: 'd2', name: 'Development' }], teams: [] }, deputy: true };
    mockApi({ 'GET /api/org': [200, { ...ORG_WITH_TEAMS, people: [...ORG.people, oleg] }] });
    render(<MapScreen {...PROPS} />);
    expect((await screen.findByText('Oleg')).closest('li')).toHaveTextContent('Deputy: Marketing, Development');
    expect(screen.getByText('Maria').closest('li')).toHaveTextContent('Deputy CEO');
  });

  it("puts a square per employee on a department's card, colored by what it does", async () => {
    const stream = fakeStream();
    const [dev] = DEV_ORG.departments;
    const one = (id: string, status: Employee['status']): Employee => ({ ...dev!.employees[1]!, id, name: id, status });
    const staffed = { ...DEV_ORG, departments: [{ ...dev!, employees: [one('a', 'working'), one('b', 'waiting'), one('c', 'idle'), one('d', 'idle')] }] };
    let later = false;
    mockApi({ 'GET /api/org': () => [200, later ? { ...staffed, departments: [{ ...staffed.departments[0]!, employees: [one('a', 'handed'), ...staffed.departments[0]!.employees.slice(1)] }] } : staffed] });
    const { container } = render(<MapScreen {...PROPS} />);
    const cells = await screen.findByRole('img', { name: 'working: 1, waiting for a decision: 1, free: 2' });
    expect([...cells.querySelectorAll('.cell')].map(c => c.className)).toEqual(['cell w', 'cell h', 'cell', 'cell']);
    later = true;
    stream.send({ type: 'task', id: 't1' });
    /* The square whose employee changed flashes once, even when the company is fetched again meanwhile. */
    await vi.waitFor(() => expect(container.querySelector('.cell.r.ping')).not.toBeNull());
    stream.send({ type: 'org' });
    await vi.waitFor(() => expect(container.querySelector('.cell.ping')).toBeNull(), { timeout: 2000 });
    expect(container.querySelector('.cell.r')).not.toBeNull();
  });

  it('fills the half gauge one segment of 24 per share of working agents', async () => {
    mockApi({ 'GET /api/org': [200, { ...ORG, agents: { total: 4, working: 1 } }] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('agents working');
    expect(container.querySelector('.hub-num')).toHaveTextContent('1/4');
    expect(container.querySelector('.gauge-bg')).toHaveAttribute('pathLength', '24');
    expect(container.querySelector('.gauge')).toHaveAttribute('pathLength', '6');
  });

  it('joins the people to the orchestrator with a trace, even before any department', async () => {
    mockApi({ 'GET /api/org': [200, ORG] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('agents working');
    expect(container.querySelector('.wires [data-wire="people"]')).toBeInTheDocument();
    expect(container.querySelectorAll('.wires .via')).toHaveLength(1);
  });

  it('places departments around the orchestrator, each on its own trace', async () => {
    mockApi({ 'GET /api/org': [200, ORG_WITH_TEAMS] });
    const { container } = render(<MapScreen {...PROPS} />);
    expect(await screen.findByText('Marketing')).toBeInTheDocument();
    expect(screen.getByText('Development')).toBeInTheDocument();
    expect(screen.getByText('2 teams')).toBeInTheDocument();
    expect(screen.queryByText(/No departments yet/)).not.toBeInTheDocument();
    expect(container.querySelector('.wires [data-wire="d1"]')).toBeInTheDocument();
    expect(container.querySelector('.wires [data-wire="d2"]')).toBeInTheDocument();
    expect(container.querySelectorAll('.dept .corner')).toHaveLength(2);
  });

  it('says where the orchestrator runs in the line at the bottom, and leaves that to his window once it is open', async () => {
    mockApi({ 'GET /api/org': [200, ORG_WITH_TEAMS] });
    const { container, rerender } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Marketing');
    expect(container.querySelector('.ticker')).toHaveTextContent('OrchestratorReady, on the Anthropic key ending 9f3a');
    expect(container.querySelector('.hub-orchestrator')).not.toBeInTheDocument();
    rerender(<MapScreen {...PROPS} windowOpen />);
    expect(container.querySelector('.ticker')).not.toBeInTheDocument();
  });

  it('shows the zoom as a percentage', async () => {
    mockApi({ 'GET /api/org': [200, ORG_WITH_TEAMS] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Marketing');
    expect(container.querySelector('.zoom .zv')).toHaveTextContent('100%');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(container.querySelector('.zoom .zv')).toHaveTextContent('120%');
  });

  it('keeps the people above the top row however many rows there are', async () => {
    const many = { ...ORG_WITH_TEAMS, departments: Array.from({ length: 8 }, (_, i) => ({ ...ORG_WITH_TEAMS.departments[0]!, id: `d${i}`, name: `Dept ${i}` })) };
    mockApi({ 'GET /api/org': [200, many] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Dept 7');
    const top = Math.min(...[...container.querySelectorAll<HTMLElement>('.dept')].map(d => parseFloat(d.style.top)));
    expect(parseFloat(container.querySelector<HTMLElement>('.chips')!.style.top) + 56).toBeLessThanOrEqual(top - 20);
  });

  it('sends no pulses while nobody exchanges messages', async () => {
    mockApi({ 'GET /api/org': [200, ORG_WITH_TEAMS] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Marketing');
    expect(container.querySelectorAll('animateMotion')).toHaveLength(0);
  });

  it('moves the dot along the gauge while an agent works', async () => {
    mockApi({ 'GET /api/org': [200, { ...ORG, agents: { total: 1, working: 1 } }] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('agents working');
    expect(container.querySelector('.hub animateMotion')).toBeInTheDocument();
  });

  it('keeps the gauge still for a person who asks for less motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    mockApi({ 'GET /api/org': [200, { ...ORG, agents: { total: 1, working: 1 } }] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('agents working');
    expect(container.querySelectorAll('animateMotion')).toHaveLength(0);
  });

  it('opens the orchestrator from the empty map and from the hub', async () => {
    mockApi({ 'GET /api/org': [200, ORG] });
    let opened = 0;
    render(<MapScreen {...PROPS} onOpenOrchestrator={() => opened++} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Build the company' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open the orchestrator' }));
    expect(opened).toBe(2);
  });

  it('gives a department-scope person nothing to open', async () => {
    mockApi({ 'GET /api/org': [200, ORG] });
    render(<MapScreen {...PROPS} me={DEPUTY} />);
    await screen.findByText(/No departments yet/);
    expect(screen.queryByRole('button', { name: 'Build the company' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open the orchestrator' })).not.toBeInTheDocument();
  });

  it('names template departments in the person\'s language and counts their products', async () => {
    const org = { ...ORG, departments: [dept({ id: 'd1', templateKey: 'sales' }), dept({ id: 'd2', templateKey: 'development', roleCode: 'DEV', products: [{ id: 'p1', name: 'Mascot' }, { id: 'p2', name: 'Characters' }] })] };
    mockApi({ 'GET /api/org': [200, org] });
    const { container, unmount } = render(<MapScreen {...PROPS} />);
    expect(await screen.findByText('Sales')).toBeInTheDocument();
    expect(screen.getByText('Mascot, Characters')).toBeInTheDocument();
    expect(screen.getAllByText('No agents yet')).toHaveLength(2);
    expect([...container.querySelectorAll('.dept .cnt')].map(c => c.textContent)).toEqual(['0/0', '0/0']);
    /* Departments are added by asking the orchestrator. */
    expect(screen.queryByRole('button', { name: '+ Add department' })).not.toBeInTheDocument();
    unmount();
    localStorage.setItem('hh-lang', 'ru');
    try {
      render(<LanguageProvider><MapScreen {...PROPS} /></LanguageProvider>);
      expect(await screen.findByText('Продажи')).toBeInTheDocument();
      expect(screen.getAllByText('Пока без агентов')).toHaveLength(2);
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });

  it('runs a pulse once along the trace a message took', async () => {
    const stream = fakeStream();
    mockApi({ 'GET /api/org': [200, { ...ORG, departments: [dept({ id: 'd1', templateKey: 'sales' })] }] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Sales');
    vi.useFakeTimers();
    try {
      stream.send({ type: 'pulse', from: { kind: 'person', id: 'p1' }, to: { kind: 'orchestrator' } });
      stream.send({ type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'd1' } });
      expect(container.querySelectorAll('circle.pt.c')).toHaveLength(2);
      act(() => vi.advanceTimersByTime(10_000));
      expect(container.querySelectorAll('circle.pt.c')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs work back to the hub in amber, and flashes a card where work leaves or lands', async () => {
    const stream = fakeStream();
    mockApi({ 'GET /api/org': [200, { ...ORG, departments: [dept({ id: 'd1', templateKey: 'sales' }), dept({ id: 'd2', templateKey: 'design' })] }] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Sales');
    const card = (name: string) => screen.getByText(name).closest('button')!;
    vi.useFakeTimers();
    try {
      stream.send({ type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'd1' } });
      expect(container.querySelectorAll('circle.pt.c')).toHaveLength(1);
      expect(card('Sales')).not.toHaveClass('flash');
      /* The frame lights when the dot gets there, and not before. */
      for (let ms = 0; ms < 10_000 && !card('Sales').classList.contains('flash'); ms += 100) act(() => vi.advanceTimersByTime(100));
      expect(container.querySelectorAll('circle.pt.c')).toHaveLength(0);
      expect(card('Sales')).toHaveClass('flash');
      act(() => vi.advanceTimersByTime(2_000));
      expect(card('Sales')).not.toHaveClass('flash');

      stream.send({ type: 'pulse', from: { kind: 'department', id: 'd2' }, to: { kind: 'orchestrator' } });
      expect(container.querySelectorAll('circle.pt.a')).toHaveLength(1);
      expect(card('Design')).toHaveClass('flash');
      stream.send({ type: 'pulse', from: { kind: 'department', id: 'd2' }, to: { kind: 'person', id: 'p1' } });
      expect(container.querySelectorAll('circle.pt.a')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('breathes the frame of a department at work, and in amber while it waits for people', async () => {
    const [dev] = DEV_ORG.departments;
    const one = (id: string, status: Employee['status']): Employee => ({ ...dev!.employees[1]!, id, name: id, status });
    const org = {
      ...ORG,
      departments: [
        dept({ id: 'd1', templateKey: 'sales', employees: [one('a', 'working'), one('b', 'waiting')] }),
        dept({ id: 'd2', templateKey: 'design', employees: [one('c', 'waiting'), one('d', 'idle')] }),
        dept({ id: 'd3', templateKey: 'support', employees: [one('e', 'queued'), one('f', 'idle')] }),
      ],
    };
    mockApi({ 'GET /api/org': [200, org] });
    render(<MapScreen {...PROPS} />);
    const card = async (name: string) => (await screen.findByText(name)).closest('button')!;
    expect(await card('Sales')).toHaveClass('busy');
    expect(await card('Sales')).not.toHaveClass('waits');
    expect(await card('Design')).toHaveClass('waits');
    expect(await card('Support')).not.toHaveClass('busy');
    expect(await card('Support')).not.toHaveClass('waits');
  });

  it('runs the pulse to a department that was just made, once the map has fetched it', async () => {
    const stream = fakeStream();
    let loads = 0;
    mockApi({ 'GET /api/org': () => [200, ++loads === 1 ? ORG : { ...ORG, departments: [dept({ id: 'd1', templateKey: 'sales' })] }] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('agents working');
    /* The order the server sends them in when the CEO builds the company. */
    stream.send({ type: 'org' });
    stream.send({ type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'd1' } });
    await screen.findByText('Sales');
    await vi.waitFor(() => expect(container.querySelectorAll('circle.pt.c')).toHaveLength(1));
  });

  it('runs no pulse for a person who asks for less motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
    const stream = fakeStream();
    mockApi({ 'GET /api/org': [200, ORG] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('agents working');
    stream.send({ type: 'pulse', from: { kind: 'person', id: 'p1' }, to: { kind: 'orchestrator' } });
    expect(container.querySelectorAll('circle.pt')).toHaveLength(0);
  });

  it('follows the company live: a changed org is fetched again and the working count moves', async () => {
    const stream = fakeStream();
    let working = 0;
    const calls = mockApi({ 'GET /api/org': () => [200, { ...ORG, agents: { ...ORG.agents, working } }] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('agents working');
    working = 1;
    stream.send({ type: 'working', working: 1 });
    expect(container.querySelector('.hub-num')).toHaveTextContent('1/1');
    /* Who works changed, so the employees' states are fetched too. */
    await vi.waitFor(() => expect(calls.filter(c => c.path === '/api/org')).toHaveLength(2));
    stream.send({ type: 'org' });
    await vi.waitFor(() => expect(calls.filter(c => c.path === '/api/org')).toHaveLength(3));
    expect(container.querySelector('.hub-num')).toHaveTextContent('1/1');
  });

  it('shows what a department works on now where it would say it has no agents', async () => {
    mockApi({ 'GET /api/org': [200, { ...ORG, departments: [dept({ id: 'd1', name: 'Sales', current: { id: 't5', number: 5, title: 'Call ten shops' } }), dept({ id: 'd2', name: 'Support' })] }] });
    render(<MapScreen {...PROPS} />);
    const sales = await screen.findByRole('button', { name: /Sales/ });
    expect(sales.querySelector('.now')).toHaveTextContent('#5 Call ten shops');
    expect(sales).not.toHaveTextContent('No agents yet');
    expect(screen.getByRole('button', { name: /Support/ })).toHaveTextContent('No agents yet');
  });

  it("shows the company's turn under the hub, between the traces", async () => {
    mockApi({ 'GET /api/org': [200, { ...ORG_WITH_TEAMS, turn: { id: 'u3', number: 3, goal: 'Take payments' } }] });
    const { container } = render(<MapScreen {...PROPS} />);
    const turn = await screen.findByText('Turn 3');
    expect(turn.closest('.hub-turn')).toHaveTextContent('Turn 3Take payments');
    /* Traces to the lower rows leave the hub 84 to each side of its middle (600); the turn stays between them. */
    const box = container.querySelector('.hub-turn') as HTMLElement;
    expect(parseFloat(box.style.left)).toBeGreaterThanOrEqual(600 - 84);
    expect(parseFloat(box.style.left) + parseFloat(box.style.width)).toBeLessThanOrEqual(600 + 84);
  });

  it('tells when the orchestrator has no subscription', async () => {
    mockApi({ 'GET /api/org': [200, { ...ORG, orchestrator: { ...ORG.orchestrator, subscription: null } }] });
    render(<MapScreen {...PROPS} />);
    expect(await screen.findByText('Needs a subscription to start')).toBeInTheDocument();
  });
});

describe('deptLayout', () => {
  it('routes every department at right angles from the hub to the middle of its near side, without overlaps', () => {
    const spots = deptLayout(7);
    const [hx, hy] = spots[0]!.path[0]!;
    for (const s of spots) {
      const [start, bend, ...rest] = s.path;
      expect(start).toEqual([hx, hy]);
      /* The first step runs straight out along the hub's row or leaves on a 45 degree line; the rest run straight across or down. */
      if (bend![1] !== hy) expect(Math.abs(bend![0] - hx)).toBe(Math.abs(bend![1] - hy));
      let prev = bend!;
      for (const p of rest) {
        expect(p[0] === prev[0] || p[1] === prev[1]).toBe(true);
        prev = p;
      }
      const near = s.x + s.w / 2 < hx ? s.x + s.w : s.x;
      expect(prev).toEqual([near, s.y + s.h / 2]);
    }
    for (const a of spots)
      for (const b of spots)
        if (a !== b) expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
  });

  const rows = (n: number) => {
    const spots = deptLayout(n);
    const hy = spots[0]!.path[0]![1];
    return [...new Set(spots.map(s => s.y + s.h / 2 - hy))];
  };

  it('puts up to four departments at the corners around the hub, as in the prototype', () => {
    expect(rows(4)).toEqual([-220, 220]);
    expect(deptLayout(4).map(s => [s.w, s.h])).toEqual(Array(4).fill([280, 160]));
  });

  it('stacks more rows evenly around the hub instead of hanging them below', () => {
    expect(rows(6)).toEqual([-220, 0, 220]);
    expect(rows(8)).toEqual([-330, -110, 110, 330]);
  });
});
