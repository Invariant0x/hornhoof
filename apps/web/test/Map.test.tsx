import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { orchestratorStatus, deptLayout, pulsePath, MapScreen } from '../src/screens/Map';
import type { SubView } from '../src/types';
import { LanguageProvider } from '../src/i18n';
import type { Department, Employee, Me } from '../src/types';
import { DEV_ORG, ME, mockApi, ORG, ORG_WITH_TEAMS, PEOPLE, SUBS } from './api-mock';
import { fakeStream } from './fake-stream';

const claude = SUBS[0]!;
const PROPS = { me: ME, windowOpen: false, onOpenOrchestrator: () => {} };
const DEPUTY: Me = { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } };

const dept = (d: Partial<Department> & { id: string }): Department => ({ name: null, templateKey: null, roleCode: 'SAL', about: '', agents: { total: 0, working: 0 }, products: [], teams: [], people: [], employees: [], roles: [], ...d });
/* Sales with Dan, its only person, and the counts of decisions waiting for each person by id. */
const waiting = (counts: Record<string, number | null>) => {
  const dan = { ...PEOPLE[2]!, id: 'p4', name: 'Dan', title: '', status: 'active' as const, access: { whole: false, departments: [{ id: 'd1', name: 'Sales' }], teams: [] } };
  const count = <P extends { id: string }>(p: P) => ({ ...p, pendingDecisions: counts[p.id] ?? 0 });
  return { ...ORG, people: ORG.people.map(count), departments: [dept({ id: 'd1', templateKey: 'sales', people: [count(dan)] })] };
};
/* A department's head, by id. */
const head = (id: string): Employee => ({ ...DEV_ORG.departments[0]!.employees[0]!, id, name: id, status: 'idle' });
const STATES: [string, SubView | null, string, string][] = [
  ['none', null, 'Needs a subscription to start', 'Чтобы начать, нужна подписка'],
  ['API key', SUBS[3]!, 'Ready, on the Anthropic key ending 9f3a', 'На связи, ключ Anthropic, последние символы 9f3a'],
  ['waiting for the machine', { ...claude, status: 'waiting_machine', online: false, machines: [] }, "Waiting for Ivan's machine", 'Ждет машину, владелец Ivan'],
  ['needs login', { ...claude, status: 'needs_login' }, 'Waiting for the Claude login', 'Ждет входа в Claude'],
  ['ready and offline', { ...claude, online: false }, "Ivan's machine is offline", 'Машина не в сети, владелец Ivan'],
  ['ready and online', claude, "Ready, on Ivan's Claude subscription", 'На связи, подписка Claude, владелец Ivan'],
];


/* The dots that run once, one per message; the signal to a person decisions wait for keeps running and is not counted. */
/* The dots that keep running along one way, by where each starts on it: null at the start, a negative begin further on. */
const runningDots = (container: HTMLElement, tone: 'c' | 'a', d: string) =>
  [...container.querySelectorAll(`circle.pt.${tone} animateMotion`)].filter(m => m.getAttribute('path') === d && m.getAttribute('repeatCount') === 'indefinite' && m.getAttribute('keyPoints') === null).map(m => m.getAttribute('begin'));
/* The same SVG path, drawn from its last point to its first. */
const backwards = (d: string) => `M ${d.slice(2).split(' L ').reverse().join(' L ')}`;
const shots = (container: HTMLElement, tone: 'c' | 'a') => [...container.querySelectorAll(`circle.pt.${tone}`)].filter(c => c.querySelector('animateMotion')?.getAttribute('repeatCount') === '1');
describe('orchestratorStatus', () => {
  it.each(STATES)('says where the orchestrator runs: %s', (_, sub, english, russian) => {
    expect(orchestratorStatus(en, sub)).toBe(english);
    expect(orchestratorStatus(ru, sub)).toBe(russian);
  });

  it("says until when his plan is at its limit, once he could run otherwise", () => {
    expect(orchestratorStatus(en, claude, '14:30')).toBe('Waiting for the limit to reset at 14:30');
    expect(orchestratorStatus(ru, claude, '14:30')).toBe('Ждет, пока лимит обновится в 14:30');
    expect(orchestratorStatus(en, SUBS[3]!, '14:30')).toBe('Waiting for the limit to reset at 14:30');
    expect(orchestratorStatus(en, { ...claude, online: false }, '14:30')).toBe("Ivan's machine is offline");
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

  it("says in the line at the bottom what the orchestrator's program does, and the server's alarm in red, in each language", async () => {
    const now = Date.now();
    const at = (m: number) => now - m * 60_000;
    const thinking = { state: 'thinking' as const, since: at(7), tool: null, screenAt: at(0), signAt: null, retry: null, reportedAt: at(0) };
    const cases = [
      ['en', null, 'thinking 7 min'],
      ['ru', null, 'думает 7 мин'],
      ['en', { reason: 'node_silent' as const, since: at(125) }, 'node silent 125 min'],
      ['ru', { reason: 'node_silent' as const, since: at(125) }, 'нода молчит 125 мин'],
    ] as const;
    for (const [lang, alarm, text] of cases) {
      localStorage.setItem('hh-lang', lang);
      onTestFinished(() => localStorage.removeItem('hh-lang'));
      mockApi({ 'GET /api/org': [200, { ...ORG, serverNow: new Date(now).toISOString(), orchestrator: { ...ORG.orchestrator!, program: thinking, alarm } }] });
      const { container, unmount } = render(<LanguageProvider><MapScreen {...PROPS} /></LanguageProvider>);
      await screen.findByText('Ivan');
      expect(container.querySelector('.ticker .ast')).toHaveTextContent(text);
      expect(container.querySelector('.ticker .ast')!.classList.contains('alarm')).toBe(alarm !== null);
      unmount();
    }
    mockApi({ 'GET /api/org': [200, ORG] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Ivan');
    expect(container.querySelector('.ticker .ast')).toBeNull();
  });

  it("shows in the line at the bottom that the orchestrator waits for his plan's limit to reset, and not after", async () => {
    const at = new Date(Date.now() + 3_600_000);
    mockApi({ 'GET /api/org': [200, { ...ORG, orchestrator: { ...ORG.orchestrator!, limitUntil: at.toISOString() } }] });
    const { container, unmount } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Ivan');
    const time = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', ...(at.toDateString() === new Date().toDateString() ? {} : { weekday: 'short' }) }).format(at);
    expect(container.querySelector('.ticker .tx')).toHaveTextContent(`Waiting for the limit to reset at ${time}`);
    expect(container.querySelector('.ticker .live')).toHaveClass('off');
    unmount();
    mockApi({ 'GET /api/org': [200, { ...ORG, orchestrator: { ...ORG.orchestrator!, limitUntil: new Date(Date.now() - 60_000).toISOString() } }] });
    const again = render(<MapScreen {...PROPS} />);
    await screen.findByText('Ivan');
    expect(again.container.querySelector('.ticker .tx')).toHaveTextContent('Ready, on the Anthropic key ending 9f3a');
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

  it('shows a multi-department deputy in the department strip while whole-company deputies stay on top', async () => {
    const oleg = { ...PEOPLE[2]!, id: 'p5', name: 'Oleg', title: '', access: { whole: false, departments: [{ id: 'd1', name: 'Marketing' }, { id: 'd2', name: 'Development' }], teams: [] }, deputy: true, departments: ['d1', 'd2'] };
    mockApi({ 'GET /api/org': [200, { ...ORG_WITH_TEAMS, people: [...ORG.people, oleg] }] });
    const { container } = render(<MapScreen {...PROPS} />);
    expect((await screen.findByText('Oleg')).closest('li')).toHaveTextContent('Deputy: Marketing, Development');
    expect(container.querySelector('.dept-chips')).toContainElement(screen.getByText('Oleg'));
    expect(container.querySelector('.chips')).toContainElement(screen.getByText('Maria'));
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
    const cells = await screen.findByRole('img', { name: 'working: 1, needs a decision: 1, free: 2' });
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

  it.each([375, 1440])('fits the company clear of a left panel at %ipx', async width => {
    mockApi({ 'GET /api/org': [200, ORG_WITH_TEAMS] });
    const { container } = render(<MapScreen {...PROPS} leftPanelOpen />);
    await screen.findByText('Marketing');
    const map = container.querySelector<HTMLElement>('.map')!;
    Object.defineProperties(map, { clientWidth: { value: width }, clientHeight: { value: 900 } });
    fireEvent.click(screen.getByRole('button', { name: 'Show everything' }));
    const world = container.querySelector<HTMLElement>('.world')!;
    const match = /translate\(([^p]+)px, [^p]+px\) scale\(([^)]+)\)/.exec(world.style.transform)!;
    for (const department of world.querySelectorAll<HTMLElement>('.dept')) {
      const x = Number(match[1]) + parseFloat(department.style.left) * Number(match[2]);
      expect(x).toBeGreaterThanOrEqual(width === 1440 ? 464 : 32);
      expect(x + parseFloat(department.style.width) * Number(match[2])).toBeLessThanOrEqual(width - 32);
    }
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

  it('keeps a slower work dot on the gauge under reduced motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    mockApi({ 'GET /api/org': [200, { ...ORG, agents: { total: 1, working: 1 } }] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('agents working');
    expect(container.querySelector('.hub circle.pt animateMotion')).toBeInTheDocument();
  });

  it('opens the orchestrator from the empty map and from the hub', async () => {
    mockApi({ 'GET /api/org': [200, ORG] });
    let opened = 0;
    render(<MapScreen {...PROPS} onOpenOrchestrator={() => opened++} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Build the company' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open the orchestrator' }));
    expect(opened).toBe(2);
  });

  it('puts a count on the card of each person decisions wait for, runs an amber signal to them, and opens their decisions', async () => {
    const onOpenDecisions = vi.fn();
    mockApi({ 'GET /api/org': [200, waiting({ p1: 1, p2: 0, p4: 2 })] });
    const { container } = render(<MapScreen {...PROPS} onOpenDecisions={onOpenDecisions} />);
    const dan = await screen.findByRole('button', { name: 'Dan: 2 decisions wait' });
    expect(dan).toHaveClass('attn');
    expect(within(dan).getByText('2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ivan: 1 decision waits' })).toHaveClass('attn');
    const maria = screen.getByRole('button', { name: 'Maria: no decisions wait' });
    expect(maria).not.toHaveClass('attn');
    expect(maria.querySelector('.chip-count')).toBeNull();
    /* Whole-company people get their way from the hub; department people get theirs from their department. */
    const signals = [...container.querySelectorAll('.wires path[data-ask]')];
    expect(signals.map(s => s.getAttribute('data-ask'))).toEqual(['p1', 'p4']);
    expect(signals[0]!.getAttribute('d')!.startsWith('M 600 300 ')).toBe(true);
    expect(signals[1]!.getAttribute('d')).toBe('M 110 200 L 70 200');
    for (const s of signals) {
      const d = s.getAttribute('d')!;
      expect(s).toHaveClass('tr', 'live', 'a');
      expect(runningDots(container, 'a', d)).toHaveLength(2);
    }
    expect(container.querySelector('.hub')).toHaveClass('attn');
    fireEvent.click(dan);
    expect(onOpenDecisions).toHaveBeenCalledWith('p4');
    fireEvent.click(maria);
    expect(onOpenDecisions).toHaveBeenLastCalledWith('p2');
  });

  it('gives a person with one department a card beside it, once, and keeps the count when the map is fetched again', async () => {
    const stream = fakeStream();
    let counts: Record<string, number> = { p1: 0, p2: 0, p4: 1 };
    mockApi({ 'GET /api/org': () => [200, waiting(counts)] });
    const { container } = render(<MapScreen {...PROPS} />);
    expect(await screen.findByRole('button', { name: 'Dan: 1 decision waits' })).toBeInTheDocument();
    expect([...container.querySelectorAll('.chips li b')].map(b => b.textContent)).toEqual(['Ivan', 'Maria']);
    expect([...container.querySelectorAll('.dept-chips li b')].map(b => b.textContent)).toEqual(['Dan']);
    /* The last decision was answered: the count, the blinking and the signals go out. */
    counts = { p1: 0, p2: 0, p4: 0 };
    stream.send({ type: 'requests' });
    expect(await screen.findByRole('button', { name: 'Dan: no decisions wait' })).not.toHaveClass('attn');
    expect(container.querySelectorAll('.chip-count, .wires path[data-ask], .attn')).toHaveLength(0);
  });

  it('keeps two slower decision signals under reduced motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
    mockApi({ 'GET /api/org': [200, waiting({ p1: 0, p2: 0, p4: 3 })] });
    const { container } = render(<MapScreen {...PROPS} />);
    expect(await screen.findByRole('button', { name: 'Dan: 3 decisions wait' })).toHaveClass('attn');
    expect(container.querySelectorAll('.wires path[data-ask]')).toHaveLength(1);
    expect(container.querySelectorAll('.wires circle.pt.a animateMotion')).toHaveLength(2);
  });

  it("lets a department's person open their decisions, but not the orchestrator, and shows no count they cannot see", async () => {
    const onOpenDecisions = vi.fn();
    const org = waiting({ p1: 1, p4: 1 });
    mockApi({ 'GET /api/org': [200, { ...org, people: org.people.map(p => (p.id === 'p2' ? { ...p, pendingDecisions: null } : p)) }] });
    const { container } = render(<MapScreen {...PROPS} me={DEPUTY} onOpenDecisions={onOpenDecisions} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dan: 1 decision waits' }));
    expect(onOpenDecisions).toHaveBeenCalledWith('p4');
    expect(screen.getByRole('button', { name: 'Maria: open the decisions' }).querySelector('.chip-count')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open the orchestrator' })).not.toBeInTheDocument();
    expect(container.querySelector('.hub')).toHaveClass('attn');
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
      expect(shots(container, 'c')).toHaveLength(2);
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(shots(container, 'c')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves no way running after a message: the dot runs once, and the department's line stays as the server says", async () => {
    const stream = fakeStream();
    mockApi({ 'GET /api/org': [200, { ...ORG, departments: [dept({ id: 'd1', templateKey: 'sales' })] }] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Sales');
    vi.useFakeTimers();
    try {
      stream.send({ type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'd1' } });
      expect(shots(container, 'c')).toHaveLength(1);
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(container.querySelectorAll('circle.pt')).toHaveLength(0);
      expect(container.querySelectorAll('.wires path.live, .wires path[data-work]')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws the line to a department blue while its head works on the orchestrator's task, and none to a quiet one", async () => {
    const org = {
      ...ORG,
      serverNow: new Date().toISOString(),
      workLines: [
        { upstreamAgentId: 'a1', downstreamAgentId: 'h1', working: true, workEpoch: 1, returnedEpoch: null, returnedAt: null },
        { upstreamAgentId: 'a1', downstreamAgentId: 'h2', working: false, workEpoch: 1, returnedEpoch: null, returnedAt: null },
      ],
      departments: [dept({ id: 'd1', templateKey: 'sales', employees: [head('h1')] }), dept({ id: 'd2', templateKey: 'design', employees: [head('h2')] })],
    };
    mockApi({ 'GET /api/org': [200, org] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Sales');
    const work = container.querySelector('.wires path[data-work="d1"]');
    /* Dashes run along the whole trace from the hub to the card, as on every live way. */
    expect(work).toHaveClass('tr', 'live', 'c');
    expect(work!.getAttribute('d')).toBe(container.querySelector('.wires [data-wire="d1"]')!.getAttribute('d'));
    expect(runningDots(container, 'c', work!.getAttribute('d')!)).toEqual([null, expect.stringMatching(/^-\d+\.\d\ds$/)]);
    expect(container.querySelector('.wires path[data-work="d2"]')).toBeNull();
  });

  it.each(['task', 'requests'])('keeps work lines fresh while %s events keep arriving faster than the refresh delay', async type => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onTestFinished(() => { vi.useRealTimers(); });
    const stream = fakeStream();
    let working = true;
    mockApi({ 'GET /api/org': () => [200, {
      ...ORG,
      serverNow: new Date().toISOString(),
      workLines: [{ upstreamAgentId: 'a1', downstreamAgentId: 'h1', working, workEpoch: 1, returnedEpoch: null, returnedAt: null }],
      departments: [dept({ id: 'd1', name: 'Sales', employees: [head('h1')] })],
    }] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('agents working');
    const line = () => container.querySelector('.wires path[data-work="d1"]');
    expect(line()).toHaveClass('c');
    working = false;
    for (let i = 0; i < 10; i++) {
      stream.send({ type, id: 'task1' });
      await act(() => vi.advanceTimersByTimeAsync(100));
    }
    expect(line()).not.toBeInTheDocument();
    working = true;
    for (let i = 0; i < 10; i++) {
      stream.send({ type, id: 'task1' });
      await act(() => vi.advanceTimersByTimeAsync(100));
    }
    expect(line()).toHaveClass('c');
  });

  it('turns the line yellow over its whole length when the head gave a result back, for what is left of five minutes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const now = Date.now();
    /* The result came back two minutes before the page opened. */
    const org = {
      ...ORG,
      serverNow: new Date(now).toISOString(),
      workLines: [{ upstreamAgentId: 'a1', downstreamAgentId: 'h1', working: false, workEpoch: 2, returnedEpoch: 2, returnedAt: new Date(now - 2 * 60_000).toISOString() }],
      departments: [dept({ id: 'd1', templateKey: 'sales', employees: [head('h1')] })],
    };
    mockApi({ 'GET /api/org': [200, org] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Sales');
    const work = () => container.querySelector('.wires path[data-work="d1"]');
    /* Amber dashes and dots run back up the trace, from the card to the hub. */
    expect(work()).toHaveClass('tr', 'live', 'a');
    const trace = container.querySelector('.wires [data-wire="d1"]')!.getAttribute('d')!;
    expect(work()!.getAttribute('d')).toBe(backwards(trace));
    expect(runningDots(container, 'a', backwards(trace))).toHaveLength(2);
    await act(() => vi.advanceTimersByTimeAsync(2.5 * 60_000));
    expect(work()).toHaveClass('live', 'a');
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(work()).toBeNull();
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
      expect(shots(container, 'c')).toHaveLength(1);
      expect(card('Sales')).not.toHaveClass('flash');
      /* The frame lights when the dot gets there, and not before. */
      for (let ms = 0; ms < 10_000 && !card('Sales').classList.contains('flash'); ms += 100) act(() => { vi.advanceTimersByTime(100); });
      expect(shots(container, 'c')).toHaveLength(0);
      expect(card('Sales')).toHaveClass('flash');
      act(() => { vi.advanceTimersByTime(2_000); });
      expect(card('Sales')).not.toHaveClass('flash');

      stream.send({ type: 'pulse', from: { kind: 'department', id: 'd2' }, to: { kind: 'orchestrator' } });
      expect(shots(container, 'a')).toHaveLength(1);
      expect(card('Design')).toHaveClass('flash');
      stream.send({ type: 'pulse', from: { kind: 'department', id: 'd2' }, to: { kind: 'person', id: 'p1' } });
      expect(shots(container, 'a')).toHaveLength(2);
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
    await vi.waitFor(() => expect(shots(container, 'c')).toHaveLength(1));
  });

  it('keeps a slower message pulse until it arrives under reduced motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
    const stream = fakeStream();
    mockApi({ 'GET /api/org': [200, ORG] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('agents working');
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    stream.send({ type: 'pulse', from: { kind: 'person', id: 'p1' }, to: { kind: 'orchestrator' } });
    const dot = container.querySelector('circle.pt')!;
    expect(dot).toBeInTheDocument();
    const motion = dot.querySelector('animateMotion')!;
    expect(motion).toHaveAttribute('repeatCount', '1');
    const duration = parseFloat(motion.getAttribute('dur')!) * 1000;
    act(() => { vi.advanceTimersByTime(duration / 2); });
    expect(dot).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(duration / 2 + 20); });
    expect(dot).not.toBeInTheDocument();
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

  it("fetches the company again when the CEO's request for the computer changes and when the tab comes back", async () => {
    const stream = fakeStream();
    const calls = mockApi({ 'GET /api/org': [200, ORG] });
    render(<MapScreen {...PROPS} />);
    await screen.findByText('agents working');
    const loads = () => calls.filter(c => c.path === '/api/org').length;
    stream.send({ type: 'computer' });
    await vi.waitFor(() => expect(loads()).toBe(2));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await vi.waitFor(() => expect(loads()).toBe(3));
  });

  it('keeps the newest company when an older answer comes after it', async () => {
    const stream = fakeStream();
    let working = 0;
    let hold = false;
    let late = () => {};
    mockApi({
      'GET /api/org': () => {
        const reply: [number, unknown] = [200, { ...ORG, agents: { ...ORG.agents, working } }];
        if (!hold) return reply;
        hold = false;
        return new Promise(resolve => (late = () => resolve(reply)));
      },
    });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('agents working');
    hold = true;
    stream.send({ type: 'org' });
    working = 1;
    stream.send({ type: 'org' });
    await vi.waitFor(() => expect(container.querySelector('.hub-num')).toHaveTextContent('1/1'));
    await act(async () => {
      late();
      await new Promise(r => setTimeout(r, 50));
    });
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

  it('places department people beside or under their departments on ordinary traces, leaving whole-company people on top', async () => {
    const dan = { ...PEOPLE[2]!, id: 'p4', name: 'Dan', title: 'Sales lead', status: 'active' as const };
    const oleg = {
      ...PEOPLE[2]!,
      id: 'p5',
      name: 'Oleg',
      title: '',
      status: 'active' as const,
      deputy: true,
      departments: ['d1', 'd2'],
      access: { whole: false, departments: [{ id: 'd1', name: 'Sales' }, { id: 'd2', name: 'Support' }], teams: [] },
    };
    const org = {
      ...ORG,
      people: [...ORG.people, oleg],
      departments: [
        dept({ id: 'd1', name: 'Sales', people: [dan] }),
        dept({ id: 'd2', name: 'Support' }),
        dept({ id: 'd3', name: 'Design' }),
      ],
    };
    mockApi({ 'GET /api/org': [200, org] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Dan');
    expect([...container.querySelectorAll('.chips li b')].map(b => b.textContent)).toEqual(['Ivan', 'Maria']);
    expect([...container.querySelectorAll('.dept-chips li b')].map(b => b.textContent)).toEqual(['Dan', 'Oleg']);

    const danLi = screen.getByText('Dan').closest('li') as HTMLElement;
    expect(danLi.style.left).toBe('-86px');
    expect(danLi.style.top).toBe('176px');
    expect(danLi.style.width).toBe('156px');
    expect(danLi.style.height).toBe('48px');

    const danWire = container.querySelector('.wires path.tr[data-person="p4"]')!;
    expect(danWire.getAttribute('class')).toBe('tr');
    expect(danWire.getAttribute('d')).toBe('M 110 200 L 70 200');
  });

  it('runs pulses along a department person line and sends waiting decision signals from the waiting department', async () => {
    const stream = fakeStream();
    const waiter: Employee = { ...DEV_ORG.departments[0]!.employees[0]!, id: 'e2', name: 'Waiter', status: 'waiting' };
    const dan = { ...PEOPLE[2]!, id: 'p4', name: 'Dan', title: '', status: 'active' as const, pendingDecisions: 0 };
    const oleg = {
      ...PEOPLE[2]!,
      id: 'p5',
      name: 'Oleg',
      title: '',
      status: 'active' as const,
      deputy: true,
      departments: ['d1', 'd3'],
      pendingDecisions: 1,
      access: { whole: false, departments: [{ id: 'd1', name: 'Sales' }, { id: 'd3', name: 'Support' }], teams: [] },
    };
    const org = {
      ...ORG,
      people: [...ORG.people.map(p => ({ ...p, pendingDecisions: 0 })), oleg],
      departments: [
        dept({ id: 'd1', name: 'Sales', people: [dan] }),
        dept({ id: 'd2', name: 'Design' }),
        dept({ id: 'd3', name: 'Support', employees: [waiter] }),
      ],
    };
    expect(pulsePath({ kind: 'person', id: 'p4' }, { kind: 'department', id: 'd1' }, org)).toEqual([[70, 200], [110, 200]]);
    expect(pulsePath({ kind: 'department', id: 'd1' }, { kind: 'person', id: 'p4' }, org)).toEqual([[110, 200], [70, 200]]);
    expect(pulsePath({ kind: 'person', id: 'p4' }, { kind: 'orchestrator' }, org)).toBeNull();

    mockApi({ 'GET /api/org': [200, org] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Oleg');

    /* Oleg looks after Sales (row 0) and Support (row 1) in the left column; Support waits, so the signal starts on Support (y=574). */
    const ask = container.querySelector('.wires path[data-ask="p5"]')!;
    expect(ask.getAttribute('d')).toBe('M 110 574 L 96 574 L 96 420 L 70 420');
    expect(ask).toHaveClass('tr', 'live', 'a');
    expect(runningDots(container, 'a', ask.getAttribute('d')!)).toHaveLength(2);

    vi.useFakeTimers();
    try {
      stream.send({ type: 'pulse', from: { kind: 'person', id: 'p4' }, to: { kind: 'department', id: 'd1' } });
      expect(shots(container, 'c')).toHaveLength(1);
      expect(shots(container, 'c')[0]!.querySelector('animateMotion')!.getAttribute('path')).toBe('M 70 200 L 110 200');
      stream.send({ type: 'pulse', from: { kind: 'department', id: 'd1' }, to: { kind: 'person', id: 'p4' } });
      expect(shots(container, 'a')).toHaveLength(1);
      expect(shots(container, 'a')[0]!.querySelector('animateMotion')!.getAttribute('path')).toBe('M 110 200 L 70 200');
    } finally {
      vi.useRealTimers();
    }
  });

  it('includes docked department chips in the Fit bounds', async () => {
    const scaleOf = async (withDeptPerson: boolean) => {
      const dan = { ...PEOPLE[2]!, id: 'p4', name: 'Dan', title: '', status: 'active' as const };
      const org = {
        ...ORG,
        departments: [
          dept({ id: 'd1', name: 'Sales', people: withDeptPerson ? [dan] : [] }),
          dept({ id: 'd2', name: 'Support', people: withDeptPerson ? [{ ...dan, id: 'p6', name: 'Eva' }] : [] }),
        ],
      };
      mockApi({ 'GET /api/org': [200, org] });
      const { container, unmount } = render(<MapScreen {...PROPS} />);
      await screen.findByText('agents working');
      const mapEl = container.querySelector('.map') as HTMLElement;
      Object.defineProperty(mapEl, 'clientWidth', { value: 1100, configurable: true });
      Object.defineProperty(mapEl, 'clientHeight', { value: 900, configurable: true });
      fireEvent.click(screen.getByRole('button', { name: 'Show everything' }));
      const world = container.querySelector('.world') as HTMLElement;
      const k = Number(/scale\(([^)]+)\)/.exec(world.style.transform)![1]);
      unmount();
      return k;
    };
    const withoutDocked = await scaleOf(false);
    const withDocked = await scaleOf(true);
    expect(withDocked).toBeLessThan(withoutDocked);
  });

  it.each([360, 1100])('fits every stacked chip and strip route inside a %i px map', async width => {
    const dan = { ...PEOPLE[2]!, title: '', status: 'active' as const };
    const ids = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
    const org = {
      ...ORG,
      people: [...ORG.people, { ...dan, id: 'strip', name: 'Strip', deputy: true, departments: ['d1', 'd4'] }],
      departments: ids.map(id => dept({ id, name: id, people: Array.from({ length: 3 }, (_, i) => ({ ...dan, id: `${id}:${i}`, name: `${id}:${i}` })) })),
    };
    mockApi({ 'GET /api/org': [200, org] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Strip');
    const map = container.querySelector<HTMLElement>('.map')!;
    Object.defineProperty(map, 'clientWidth', { value: width, configurable: true });
    Object.defineProperty(map, 'clientHeight', { value: 900, configurable: true });
    fireEvent.click(screen.getByRole('button', { name: 'Show everything' }));
    const transform = container.querySelector<HTMLElement>('.world')!.style.transform;
    const [, tx, ty, scale] = /translate\(([^p]+)px, ([^p]+)px\) scale\(([^)]+)\)/.exec(transform)!;
    const points = [...container.querySelectorAll<HTMLElement>('.dept-chips li')].flatMap(c => [
      [parseFloat(c.style.left), parseFloat(c.style.top)],
      [parseFloat(c.style.left) + parseFloat(c.style.width), parseFloat(c.style.top) + parseFloat(c.style.height)],
    ]);
    for (const path of container.querySelectorAll('.wires path[data-person]')) {
      const coords = path.getAttribute('d')!.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      for (let i = 0; i < coords.length; i += 2) points.push([coords[i]!, coords[i + 1]!]);
    }
    for (const [x, y] of points) {
      expect(Number(tx) + x! * Number(scale)).toBeGreaterThanOrEqual(31.99);
      expect(Number(tx) + x! * Number(scale)).toBeLessThanOrEqual(width - 31.99);
      expect(Number(ty) + y! * Number(scale)).toBeGreaterThanOrEqual(75.99);
      expect(Number(ty) + y! * Number(scale)).toBeLessThanOrEqual(828.01);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    const zoomed = container.querySelector<HTMLElement>('.world')!.style.transform;
    expect(Number(/scale\(([^)]+)\)/.exec(zoomed)![1])).toBeCloseTo(Number(scale) * 1.2);
  });

  it('keeps bridge gaps clear while a department decision and its message animate', async () => {
    const stream = fakeStream();
    const person = { ...PEOPLE[2]!, title: '', deputy: true, status: 'active' as const };
    const org = {
      ...ORG,
      people: [...ORG.people, { ...person, id: 'gutter', name: 'Gutter', departments: ['d1', 'd3'] },
        { ...person, id: 'strip', name: 'Strip', departments: ['d1', 'd4'], pendingDecisions: 1 }],
      departments: ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map(id => dept({ id, name: id })),
    };
    mockApi({ 'GET /api/org': [200, org] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Strip');
    const ask = container.querySelector('.wires path[data-ask="strip"]')!;
    expect(ask).toHaveClass('tr', 'live', 'a');
    const mask = ask.closest('g[mask]')?.getAttribute('mask');
    expect(mask).toMatch(/^url\(#.+\)$/);
    const id = mask!.slice(5, -1);
    expect(container.querySelector(`[id="${id}"] path[stroke="black"]`)).not.toBeNull();
    stream.send({ type: 'pulse', from: { kind: 'department', id: 'd1' }, to: { kind: 'person', id: 'strip' } });
    expect(shots(container, 'a')[0]!.closest('g[mask]')).toHaveAttribute('mask', mask);
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
