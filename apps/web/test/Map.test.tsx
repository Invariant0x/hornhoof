import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { orchestratorStatus, deptLayout, pulsePath, MapScreen, writtenIn } from '../src/screens/Map';
import type { SubView } from '../src/types';
import { LanguageProvider } from '../src/i18n';
import type { Department, Employee, Me } from '../src/types';
import { arcEnd } from '../src/hub-turns';
import { arrangeMap } from '../src/map-arrange';
import { DEV_ORG, ME, mockApi, ORG, ORG_WITH_TEAMS, PEOPLE, SUBS, TURN } from './api-mock';
import { fakeStream } from './fake-stream';
import { decl, rulesFor } from './css';

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
  ['needs the first setup', { ...claude, provider: 'antigravity', status: 'needs_setup' }, 'Waiting for the first setup of Antigravity', 'Ждет первой настройки Antigravity'],
  ['ready and offline', { ...claude, online: false }, "Ivan's machine is offline", 'Машина не в сети, владелец Ivan'],
  ['ready and online', claude, "Ready, on Ivan's Claude subscription", 'На связи, подписка Claude, владелец Ivan'],
];


/* The dots that run once, one per message; the signal to a person decisions wait for keeps running and is not counted. */
/* The dots that keep running along one way, by where each starts on it: null at the start, a negative begin further on. */
const runningDots = (container: HTMLElement, tone: 'c' | 'a', d: string) =>
  [...container.querySelectorAll<SVGSVGElement>('.pt-box')]
    .filter(b => b.querySelector(`circle.pt.${tone}`) && b.dataset.path === d && !b.dataset.once && !b.dataset.bounce)
    .map(b => b.dataset.phase ?? null);
/* The same SVG path, drawn from its last point to its first. */
const backwards = (d: string) => `M ${d.slice(2).split(' L ').reverse().join(' L ')}`;
const shots = (container: HTMLElement, tone: 'c' | 'a') =>
  [...container.querySelectorAll<SVGCircleElement>(`circle.pt.${tone}`)].filter(c => c.closest<SVGSVGElement>('.pt-box')?.dataset.once === '1');
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

  it('says he has a plan to a person who is not shown which one, and still when its limit resets', () => {
    expect(orchestratorStatus(en, null, null, true)).toBe('Has a subscription to work on');
    expect(orchestratorStatus(ru, null, null, true)).toBe('Подписка для работы есть');
    expect(orchestratorStatus(en, null, '14:30', true)).toBe('Waiting for the limit to reset at 14:30');
    expect(orchestratorStatus(en, null, null, false)).toBe('Needs a subscription to start');
  });
});

function reviewPipeline(department: Department, fanOut: number) {
  return { id: 'changes', department: { id: department.id, name: 'Development' }, name: 'Changes', why: '', archived: false, version: 1, stages: [
    { id: 'review', parentId: null, name: 'Review', ownerRole: 'DEV-REV', owner: null, position: 0, oneShot: { fanOut, judge: true } },
  ] };
}

describe('Map', () => {
  it('shows an ordered row of staff squares even with declared and active one-shot calls', async () => {
    const [dev] = DEV_ORG.departments;
    const employees = [{ ...dev!.employees[0]!, status: 'working' }, { ...dev!.employees[1]!, turnkey: true, status: 'off' }];
    const pipelines = [reviewPipeline(dev!, 2)];
    const calls = [
      { id: 'running', number: 1, judge: false, task: 12, by: employees[1]!.id, stage: 'review', startedAt: '2026-11-17T10:00:00.000Z' },
      { id: 'waiting', number: 2, judge: false, task: 12, by: employees[1]!.id, stage: 'review', startedAt: null },
      { id: 'ad-hoc', number: 1, judge: false, task: 13, by: employees[1]!.id, stage: null, startedAt: null },
    ];
    mockApi({ 'GET /api/org': [200, { ...DEV_ORG, departments: [{ ...dev!, employees, pipelines, calls }] }] });
    render(<MapScreen {...PROPS} />);
    const card = await screen.findByRole('button', { name: /^Development/ });
    expect([...card.querySelectorAll('.cell')].map(cell => [cell.tagName, cell.className])).toEqual([
      ['I', 'cell w'],
      ['I', 'cell o'],
    ]);
    expect(card.querySelectorAll('.cells')).toHaveLength(1);
  });

  it.each([
    ['en', 'Worker kinds'],
    ['ru', 'Виды работников'],
  ])('has no worker legend in %s', async (language, title) => {
    localStorage.setItem('hh-lang', language);
    onTestFinished(() => localStorage.removeItem('hh-lang'));
    mockApi({ 'GET /api/org': [200, DEV_ORG] });
    render(<LanguageProvider><MapScreen {...PROPS} /></LanguageProvider>);
    await screen.findByText('Ivan');
    expect(screen.queryByText(title)).not.toBeInTheDocument();
  });

  it('uses the original map card height whether or not the pipeline declares one-shot calls', () => {
    const [dev] = DEV_ORG.departments;
    const many: Department = { ...dev!, pipelines: [reviewPipeline(dev!, 80)] };
    const ordinary = arrangeMap(DEV_ORG).depts[0]!;
    const withCalls = arrangeMap({ ...DEV_ORG, departments: [many] }).depts[0]!;
    expect(ordinary.h).toBe(160);
    expect(withCalls).toEqual(ordinary);
  });

  it('makes every card of the map as tall as the most words of one need, never shorter than it was, the rows still apart', () => {
    const four = { ...DEV_ORG, departments: ['d1', 'd2', 'd3', 'd4'].map(id => dept({ id })) };
    expect(arrangeMap(four, {}, {}, 100).depts.map(d => d.h)).toEqual([160, 160, 160, 160]);
    for (const need of [230, 500]) {
      const tall = arrangeMap(four, {}, {}, need).depts;
      expect(tall.map(d => [d.w, d.h])).toEqual(Array(4).fill([280, need]));
      for (const a of tall) for (const b of tall) if (a !== b && a.x === b.x) expect(Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h)).toBeGreaterThanOrEqual(32);
    }
  });

  it('grows the cards of the map with the words of the card that has the most, and cuts or hides no word of any', async () => {
    const long = 'Development of payments and receipts kept for years in every country';
    /* jsdom lays nothing out: a card left to its words measures 230 px with the long name and 120 px without it. */
    const tall = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.matches('.map .dept') || this.style.height !== 'auto') return 0;
      return this.textContent!.includes(long) ? 230 : 120;
    });
    onTestFinished(() => tall.mockRestore());
    const [dev] = DEV_ORG.departments;
    mockApi({ 'GET /api/org': [200, { ...DEV_ORG, departments: [{ ...dev!, name: long }, dept({ id: 'd9', name: 'Sales' })] }] });
    const { container } = render(<LanguageProvider><MapScreen {...PROPS} /></LanguageProvider>);
    await screen.findByRole('button', { name: new RegExp(`^${long}`) });
    await waitFor(() => expect([...container.querySelectorAll<HTMLElement>('.map .dept')].map(c => c.style.height)).toEqual(['230px', '230px']));
    for (const selector of ['.dname', '.dept .row2', '.dept .detail', '.dept .now', '.dept .now > span'])
      for (const rule of rulesFor(selector)) {
        expect.soft(rule.decls['text-overflow'], `${selector} ends in no ellipsis`).not.toBe('ellipsis');
        expect.soft(rule.decls['white-space'], `${selector} wraps`).not.toBe('nowrap');
        expect.soft(rule.decls.overflow, `${selector} hides nothing`).not.toBe('hidden');
      }
    for (const selector of ['.dname', '.dept .detail', '.dept .now > span', '.dt-cnt']) expect.soft(decl(selector, 'overflow-wrap'), selector).toBe('break-word');
    /* The Head of Design's word for #1489 (#1539, N4): words break by the syllables of the page's language, with a hyphen. */
    expect(decl('button.dept', 'hyphens')).toBe('auto');
    expect(decl('button.dept', '-webkit-hyphens')).toBe('auto');
  });

  /* Design's note on #1574 (#1580): a Japanese chip breaks between its phrases, not inside one. The browser finds Japanese
     phrases only in text marked Japanese, and kana is written only in Japanese; text of kanji alone may be Chinese and is left
     to the page's language. */
  it('marks the words of a people chip Japanese when they hold kana, so they break between phrases', async () => {
    const people = [
      { ...PEOPLE[0]!, name: 'レナ', title: '財務と経理の責任者' },
      { ...PEOPLE[1]!, name: 'ミラ', title: '最高経営責任者' },
    ];
    mockApi({ 'GET /api/org': [200, { ...ORG, people }] });
    const { container } = render(<LanguageProvider><MapScreen {...PROPS} /></LanguageProvider>);
    await screen.findByText('レナ');
    const words = [...container.querySelectorAll('.chips .chip :is(b, small)')].map(el => [el.textContent, el.getAttribute('lang')]);
    expect(Object.fromEntries(words)).toEqual({ レナ: 'ja', 財務と経理の責任者: 'ja', ミラ: 'ja', 最高経営責任者: null });
    for (const selector of ['.chip b:lang(ja)', '.chip small:lang(ja)']) expect.soft(decl(selector, 'word-break'), selector).toBe('auto-phrase');
    expect(decl('.chip span', 'hyphens'), 'the other languages keep their hyphens').toBe('auto');
  });

  it('shows the orchestrator, the company people and the empty state on first run', async () => {
    mockApi({ 'GET /api/org': [200, ORG] });
    const { container } = render(<MapScreen {...PROPS} />);
    expect(await screen.findByText('No departments yet. Tell the orchestrator about the company and he will propose a structure.')).toBeInTheDocument();
    expect(container.querySelector('.hub-num')).toHaveTextContent('0/1');
    /* The hub says what its number counts on hover, without a caption under it. */
    expect(screen.getByTitle('agents working')).toHaveClass('hub-num');
    expect(container.querySelector('.hub-lbl')).toBeNull();
    expect(screen.getByText('Ivan')).toBeInTheDocument();
    expect(screen.getByText('Maria')).toBeInTheDocument();
    expect(container.querySelector('.ticker')).toHaveTextContent('OrchestratorReady, on the Anthropic key ending 9f3a');
  });

  it('does not tell a person of part of the company that the orchestrator needs a plan when his plan is only hidden from them', async () => {
    const listed = { ...ME, person: { ...ME.person, id: 'p3', scopeKind: 'listed' as const, isOwner: false } };
    mockApi({ 'GET /api/org': [200, { ...ORG, orchestrator: { ...ORG.orchestrator!, subscription: null, machine: null, opens: false, planned: true } }] });
    const { container } = render(<MapScreen {...PROPS} me={listed} />);
    await screen.findByText('Ivan');
    expect(container.querySelector('.ticker')).toHaveTextContent('OrchestratorHas a subscription to work on');
    expect(container.querySelector('.ticker')).not.toHaveTextContent('Needs a subscription to start');
  });

  it("lights the orchestrator's dot alike for everyone while his program works, from what everyone is shown", async () => {
    const listed = { ...ME, person: { ...ME.person, id: 'p3', scopeKind: 'listed' as const, isOwner: false } };
    const hidden = { subscription: null, machine: null, opens: false, planned: true };
    const now = Date.now();
    const thinking = { state: 'thinking' as const, since: now, tool: null, screenAt: now, signAt: null, retry: null, reportedAt: now };
    const cases = [
      [null, null, false],
      [thinking, null, true],
      [{ ...thinking, state: 'asking' as const }, null, true],
      [{ ...thinking, state: 'gone' as const }, null, false],
      [thinking, { reason: 'program_stalled' as const, since: now }, false],
    ] as const;
    for (const [program, alarm, works] of cases) {
      for (const [me, shown] of [[ME, {}], [listed, hidden]] as const) {
        mockApi({ 'GET /api/org': [200, { ...ORG, orchestrator: { ...ORG.orchestrator!, planned: true, ...shown, program, alarm } }] });
        const { container, unmount } = render(<MapScreen {...PROPS} me={me} />);
        await screen.findByText('Ivan');
        expect([me.person.id, program?.state ?? null, alarm?.reason ?? null, container.querySelector('.ticker .live')!.classList.contains('off')]).toEqual([me.person.id, program?.state ?? null, alarm?.reason ?? null, !works]);
        unmount();
      }
    }
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
    /* The page's steady clock stands still, so 7 and 125 minutes stay what they are while the test runs. */
    vi.useFakeTimers({ toFake: ['performance'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
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
    /* The page's clock stands at noon, so the reset an hour on is today whenever the test runs. */
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 3, 12, 0));
    onTestFinished(() => {
      vi.useRealTimers();
    });
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
    expect(await screen.findByTitle('agents working')).toBeInTheDocument();
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
    const card = await screen.findByRole('button', { name: /^Development/ });
    const cells = within(card).getByRole('img', { name: 'working: 1, needs a decision: 1, free: 2' });
    expect([...cells.querySelectorAll('.cell')].map(c => c.className)).toEqual(['cell w', 'cell h', 'cell', 'cell']);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      later = true;
      stream.send({ type: 'task', id: 't1' });
      /* The company is fetched again once task changes settle, 400 ms on. */
      await act(() => vi.advanceTimersByTimeAsync(400));
      /* The square whose employee changed flashes once, for 950 ms, even when the company is fetched again meanwhile. */
      expect(container.querySelector('.cell.r.ping')).not.toBeNull();
      stream.send({ type: 'org' });
      await act(() => vi.advanceTimersByTimeAsync(949));
      expect(container.querySelector('.cell.r.ping')).not.toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(container.querySelector('.cell.ping')).toBeNull();
      expect(container.querySelector('.cell.r')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fills the upper gauge one segment of 24 per share of working agents, clear of both ends of the middle line', async () => {
    mockApi({ 'GET /api/org': [200, { ...ORG, agents: { total: 4, working: 1 } }] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByTitle('agents working');
    expect(container.querySelector('.hub-num')).toHaveTextContent('1/4');
    expect(container.querySelector('.gauge-bg')).toHaveAttribute('pathLength', '23.72');
    expect(container.querySelector('.gauge-bg')).toHaveAttribute('d', `M ${arcEnd(186)} A 103 103 0 0 1 ${arcEnd(354)}`);
    expect(container.querySelector('.gauge')).toHaveAttribute('pathLength', '5.72');
    expect(container.querySelector('.gauge')!.getAttribute('d')).toBe(`M ${arcEnd(186)} A 103 103 0 0 1 ${arcEnd(186 + (168 * 5.72) / 23.72)}`);
    /* The middle line stops 32 short of the inner circle on both sides. */
    expect(container.querySelector('.hub-hz')).toHaveAttribute('d', 'M 64 120 L 176 120');
  });

  it('joins the people to the orchestrator with a trace, even before any department', async () => {
    mockApi({ 'GET /api/org': [200, ORG] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByTitle('agents working');
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

  /* The map runs to the bottom of the screen and names the running build over its own corner, in the room its bars leave
     free; it holds the place while the company loads, so the footer row never comes and goes under it (#1590). */
  it('names the running build over the corner of its room, from the moment it opens, and not behind a department', async () => {
    let answer: (reply: [number, unknown]) => void = () => {};
    mockApi({ 'GET /api/org': () => new Promise(done => (answer = done)), 'GET /api/version': [200, { version: '0.39.1', commit: 'a276aa6c0ffee' }] });
    const { container, rerender } = render(<MapScreen {...PROPS} />);
    expect(container.querySelector('.map[aria-busy="true"] > .map-version')).toBeInTheDocument();
    await waitFor(() => expect(container.querySelector('.map-version')).toHaveTextContent('0.39.1 (a276aa6)'));
    answer([200, ORG_WITH_TEAMS]);
    await screen.findByText('Marketing');
    await waitFor(() => expect(container.querySelector('.map > .map-room > .map-version')).toHaveTextContent('0.39.1 (a276aa6)'));
    expect(container.querySelectorAll('.map-version')).toHaveLength(1);
    rerender(<MapScreen {...PROPS} inside />);
    expect(container.querySelector('.map-version')).not.toBeInTheDocument();
  });

  it('shows the zoom as a percentage across short and three-digit scales', async () => {
    mockApi({ 'GET /api/org': [200, ORG_WITH_TEAMS] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Marketing');
    const label = container.querySelector('.zoom .zv')!;
    expect(label).toHaveTextContent('100%');
    expect(container.querySelectorAll('.zoom .zbtn')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(label).toHaveTextContent('120%');
    for (let i = 0; i < 6; i++) fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(label).toHaveTextContent('250%');
    for (let i = 0; i < 12; i++) fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(label).toHaveTextContent('30%');
  });

  /* Since 20.11 the arrangement comes before the map is drawn (#1620), so the person's view is theirs only after it came. */
  it('leaves the view where the person put it as the company changes live, panels open and a department closes, and opens it there again', async () => {
    const width = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1100);
    const height = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(900);
    onTestFinished(() => {
      width.mockRestore();
      height.mockRestore();
    });
    const stream = fakeStream();
    let arrive = () => {};
    const kept = new Promise<[number, unknown]>(resolve => (arrive = () => resolve([200, { blocks: { 'dept:d1': { x: 40, y: 700 } } }])));
    mockApi({ 'GET /api/org': [200, ORG_WITH_TEAMS], 'GET /api/map/layout': () => kept });
    const opened: string[] = [];
    const { container, rerender, unmount } = render(<MapScreen {...PROPS} onOpenDepartment={id => opened.push(id)} />);
    await act(async () => arrive());
    const marketing = (await screen.findByText('Marketing')).closest<HTMLElement>('.dept')!;
    expect(marketing.style.left).toBe('40px');
    const view = () => container.querySelector<HTMLElement>('.world')!.style.transform;
    /* The map shows all of itself when it first opens; then the person zooms in. */
    await waitFor(() => expect(view()).not.toBe('translate(0px, 0px) scale(1)'));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    const mine = view();
    stream.send({ type: 'working', working: 1 });
    await act(async () => {});
    expect(view()).toBe(mine);
    rerender(<MapScreen {...PROPS} onOpenDepartment={id => opened.push(id)} windowOpen leftPanelOpen />);
    expect(view()).toBe(mine);
    /* Into a department and out of it: the map flies into its card, and comes back to where the person left it. */
    fireEvent.click(marketing);
    await waitFor(() => expect(opened).toEqual(['d1']));
    rerender(<MapScreen {...PROPS} onOpenDepartment={id => opened.push(id)} windowOpen leftPanelOpen inside />);
    rerender(<MapScreen {...PROPS} onOpenDepartment={id => opened.push(id)} windowOpen leftPanelOpen />);
    expect(view()).toBe(mine);
    /* A reload opens the map where the person left it, at the same scale. */
    unmount();
    const again = render(<MapScreen {...PROPS} />);
    await screen.findByText('Marketing');
    expect(again.container.querySelector<HTMLElement>('.world')!.style.transform).toBe(mine);
  });

  /* 20.11 (#1620): the map was drawn before the arrangement came, and then its blocks jumped to their places and it zoomed
     out again. Now it is drawn once the arrangement came: the blocks stand where the server keeps them and the view shows all
     of them from the first frame, and nothing moves after it. */
  it('shows all of the map as it first opens, with the blocks where the server keeps them from its first frame, until the person moves it', async () => {
    const width = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1100);
    const height = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(900);
    onTestFinished(() => {
      width.mockRestore();
      height.mockRestore();
    });
    /* A view kept in a form the map cannot read counts as none. */
    localStorage.setItem(`hh-map-view:${ME.company.id}:${ME.person.id}`, '{"k":"far"}');
    let arrive = () => {};
    const kept = new Promise<[number, unknown]>(resolve => (arrive = () => resolve([200, { blocks: { 'dept:d1': { x: 40, y: 1400 } } }])));
    mockApi({ 'GET /api/org': [200, ORG_WITH_TEAMS], 'GET /api/map/layout': () => kept });
    const { container } = render(<MapScreen {...PROPS} />);
    await act(async () => {});
    expect(screen.queryByText('Marketing')).not.toBeInTheDocument();
    expect(container.querySelector('.world')).toBeNull();
    await act(async () => arrive());
    const marketing = (await screen.findByText('Marketing')).closest<HTMLElement>('.dept')!;
    expect(marketing.style.top).toBe('1400px');
    const transform = () => container.querySelector<HTMLElement>('.world')!.style.transform;
    const first = transform();
    /* A company that fits whole opens no larger than it is drawn (#1597); this one, with a block kept low, opens below 100%. */
    expect(Number(/scale\(([^)]+)\)/.exec(first)![1]), 'the map opens no larger than it is drawn').toBeLessThan(1);
    await act(async () => {});
    expect(transform()).toBe(first);
  });

  it('zooms with the wheel once it is drawn, also when the arrangement came after the company', async () => {
    /* #1620: the map stands only once the company and the arrangement came, so the wheel must reach the map then, not
       the room that held its place while the company alone was there. */
    let arrive = () => {};
    const kept = new Promise<[number, unknown]>(resolve => (arrive = () => resolve([200, { blocks: {} }])));
    mockApi({ 'GET /api/org': [200, ORG_WITH_TEAMS], 'GET /api/map/layout': () => kept });
    const { container } = render(<MapScreen {...PROPS} />);
    await act(async () => {});
    await act(async () => {});
    expect(container.querySelector('.world')).toBeNull();
    await act(async () => arrive());
    await screen.findByText('Marketing');
    const label = () => container.querySelector('.zoom .zv')!.textContent;
    const before = label();
    fireEvent.wheel(container.querySelector('.map:not(.map-wait)')!, { deltaY: -400, clientX: 200, clientY: 200 });
    expect(label(), 'the wheel zooms the map that is drawn').not.toBe(before);
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
    for (const card of container.querySelectorAll<HTMLElement>('.chips > li')) expect(parseFloat(card.style.top) + 56).toBeLessThanOrEqual(top - 20);
  });

  it('stands the blocks where this person put them, and puts them back as they were', async () => {
    const calls = mockApi({
      'GET /api/org': [200, ORG_WITH_TEAMS],
      'GET /api/map/layout': [200, { blocks: { 'dept:d1': { x: 40, y: 700 }, 'person:p2': { x: 900, y: 20 } } }],
      'DELETE /api/map/layout': [204, undefined],
    });
    const { container } = render(<MapScreen {...PROPS} />);
    const marketing = (await screen.findByText('Marketing')).closest<HTMLElement>('.dept')!;
    await waitFor(() => expect([marketing.style.left, marketing.style.top]).toEqual(['40px', '700px']));
    const maria = screen.getByText('Maria').closest('li')!;
    expect([maria.style.left, maria.style.top]).toEqual(['900px', '20px']);
    /* Every line still runs only across and down, now to where the blocks stand. */
    for (const path of container.querySelectorAll('.wires path.tr')) {
      for (const run of path.getAttribute('d')!.split('M ').filter(Boolean)) {
        const pts = run.trim().split(' L ').map(p => p.split(' ').map(Number));
        expect(pts.slice(1).every((q, i) => q[0] === pts[i]![0] || q[1] === pts[i]![1]), path.getAttribute('d')!).toBe(true);
      }
    }
    fireEvent.click(screen.getByRole('button', { name: 'Put back as it was' }));
    const home = deptLayout(2)[0]!;
    expect([marketing.style.left, marketing.style.top]).toEqual([`${home.x}px`, `${home.y}px`]);
    expect(container.querySelector('.wires [data-wire="d1"]')!.getAttribute('d')).toBe(`M ${home.path.map(p => p.join(' ')).join(' L ')}`);
    expect(screen.queryByRole('button', { name: 'Put back as it was' })).not.toBeInTheDocument();
    await waitFor(() => expect(calls).toContainEqual({ method: 'DELETE', path: '/api/map/layout', body: undefined }));
  });

  it('moves a block by the grip at its corner, keeps it there, and leaves the map and the block alone', async () => {
    const opened: string[] = [];
    const calls = mockApi({ 'GET /api/org': [200, ORG_WITH_TEAMS], 'PATCH /api/map/layout': (b: unknown) => [200, b] });
    const { container } = render(<MapScreen {...PROPS} onOpenDepartment={id => opened.push(id)} />);
    const marketing = (await screen.findByText('Marketing')).closest<HTMLElement>('.dept')!;
    const home = deptLayout(2)[0]!;
    const world = container.querySelector<HTMLElement>('.world')!;
    const view = world.style.transform;
    const grip = screen.getByRole('button', { name: 'Move Marketing' });
    fireEvent.pointerDown(grip, { clientX: 100, clientY: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(grip, { clientX: 130, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 160, clientY: 130, pointerId: 1 });
    /* The card follows the hand before it lets go, and nothing is kept yet. */
    expect([marketing.style.left, marketing.style.top]).toEqual([`${home.x + 60}px`, `${home.y + 30}px`]);
    expect(calls.filter(c => c.method === 'PATCH')).toEqual([]);
    fireEvent.pointerUp(grip, { clientX: 160, clientY: 130, pointerId: 1 });
    expect(world.style.transform).toBe(view);
    expect([marketing.style.left, marketing.style.top]).toEqual([`${home.x + 60}px`, `${home.y + 30}px`]);
    await waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', path: '/api/map/layout', body: { blocks: { 'dept:d1': { x: home.x + 60, y: home.y + 30 } } } }));
    expect(opened).toEqual([]);
    /* The arrow keys move it too, and a press on the card still opens the department. */
    fireEvent.keyDown(grip, { key: 'ArrowDown' });
    expect(marketing.style.top).toBe(`${home.y + 40}px`);
    await waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', path: '/api/map/layout', body: { blocks: { 'dept:d1': { x: home.x + 60, y: home.y + 40 } } } }));
    fireEvent.click(marketing);
    expect(opened).toEqual(['d1']);
    expect(screen.getByRole('button', { name: 'Put back as it was' })).toBeInTheDocument();
  });

  it('gives every block a grip named in the language of the person, the hub and the people too', async () => {
    localStorage.setItem('hh-lang', 'ru');
    onTestFinished(() => localStorage.removeItem('hh-lang'));
    mockApi({ 'GET /api/org': [200, ORG_WITH_TEAMS] });
    render(<LanguageProvider><MapScreen {...PROPS} /></LanguageProvider>);
    await screen.findByText('Marketing');
    expect(screen.getAllByRole('button', { name: /^Передвинуть: / }).map(b => b.getAttribute('aria-label'))).toEqual(
      expect.arrayContaining(['Передвинуть: Оркестратор', 'Передвинуть: Marketing', 'Передвинуть: Development', 'Передвинуть: Ivan', 'Передвинуть: Maria']),
    );
  });

  it('draws nothing at a block\'s corner but the grip over it, and a press on it that does not move opens the card under it', async () => {
    const opened: string[] = [], decisions: string[] = [];
    const calls = mockApi({ 'GET /api/org': [200, ORG_WITH_TEAMS], 'GET /api/map/layout': [200, { blocks: { 'person:p2': { x: 20, y: 60 } } }] });
    const { container } = render(<MapScreen {...PROPS} onOpenDepartment={id => opened.push(id)} onOpenDecisions={id => decisions.push(id)} />);
    const marketing = (await screen.findByText('Marketing')).closest<HTMLElement>('.dept')!;
    const maria = screen.getByText('Maria').closest('li')!;
    await waitFor(() => expect([maria.style.left, maria.style.top]).toEqual(['20px', '60px']));
    const grip = screen.getByRole('button', { name: 'Move Marketing' });
    expect(grip.childElementCount).toBe(0);
    expect(container.querySelectorAll('.grip svg')).toHaveLength(0);
    /* Its middle is the card's corner, so the corner itself takes the hand. */
    const [x, y] = [parseFloat(marketing.style.left), parseFloat(marketing.style.top)];
    expect([parseFloat(grip.style.left) + parseFloat(grip.style.width) / 2, parseFloat(grip.style.top) + parseFloat(grip.style.height) / 2]).toEqual([x, y]);
    const tap = (target: HTMLElement, at: [number, number]) => {
      fireEvent.pointerDown(target, { clientX: at[0], clientY: at[1], pointerId: 1, button: 0 });
      fireEvent.pointerUp(target, { clientX: at[0] + 1, clientY: at[1], pointerId: 1 });
    };
    /* On the card it opens the card; on the map beside it, nothing. */
    tap(grip, [x + 6, y + 6]);
    expect(opened).toEqual(['d1']);
    tap(grip, [x - 15, y + 10]);
    expect(opened).toEqual(['d1']);
    /* Maria's card stands just above the corner of Marketing: where her card is, it opens hers. */
    tap(grip, [x - 10, y - 15]);
    expect([opened, decisions]).toEqual([['d1'], ['p2']]);
    expect(calls.filter(c => c.method === 'PATCH')).toEqual([]);
  });

  it('runs the lines that go side by side as one road, drawn once, with a dot where it forks', async () => {
    const deputy = (id: string, name: string, of: string[]) => ({ ...PEOPLE[2]!, id, name, title: '', status: 'active' as const, deputy: true, departments: of, access: { whole: false, departments: of.map(d => ({ id: d, name: d })), teams: [] } });
    const ids = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
    const org = { ...ORG, people: [...ORG.people, deputy('n1', 'Oleg', ['d1', 'd5']), deputy('n2', 'Nina', ['d2', 'd3', 'd6']), deputy('n3', 'Petr', ['d2', 'd4']), deputy('n4', 'Lena', ['d1', 'd2'])], departments: ids.map(id => dept({ id, name: id })) };
    mockApi({ 'GET /api/org': [200, org] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Lena');
    const runs = [...container.querySelectorAll('.wires path.tr:not(.live)')].flatMap((path, el) =>
      path.getAttribute('d')!.split('M ').filter(Boolean).flatMap(run => {
        const pts = run.trim().split(' L ').map(p => p.split(' ').map(Number));
        return pts.slice(1).map((q, i) => {
          const p = pts[i]!, across = p[1] === q[1];
          expect(across || p[0] === q[0], path.getAttribute('d')!).toBe(true);
          const [a, b] = across ? [p[0]!, q[0]!] : [p[1]!, q[1]!];
          return { el, across, at: across ? p[1]! : p[0]!, lo: Math.min(a, b), hi: Math.max(a, b) };
        });
      }),
    );
    /* No stretch is drawn twice, and no lines run side by side along a road's length. */
    const pairs = runs.flatMap((r, i) => runs.slice(i + 1).filter(o => o.across === r.across && Math.abs(o.at - r.at) < 28 && Math.min(o.hi, r.hi) - Math.max(o.lo, r.lo) >= (o.at === r.at ? 0.5 : 28)).map(o => [r, o]));
    expect(pairs).toEqual([]);
    /* Each fork of the roads has its dot, and there is one dot to a place. */
    const dots = [...container.querySelectorAll('.wires .via')].map(c => `${c.getAttribute('cx')}:${c.getAttribute('cy')}`);
    expect(new Set(dots).size).toBe(dots.length);
    const forks = arrangeMap(org).forks;
    expect(forks.length).toBeGreaterThan(0);
    expect(dots).toEqual(expect.arrayContaining(forks.map(([x, y]) => `${x}:${y}`)));
  });

  it('says so when a move could not be kept, and a press on a grip that does not move keeps nothing', async () => {
    const calls = mockApi({ 'GET /api/org': [200, ORG_WITH_TEAMS], 'PATCH /api/map/layout': [500, { error: { code: 'internal', message: 'Down.' } }] });
    render(<MapScreen {...PROPS} />);
    await screen.findByText('Marketing');
    const grip = screen.getByRole('button', { name: 'Move Ivan' });
    fireEvent.pointerDown(grip, { clientX: 100, clientY: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(grip, { clientX: 102, clientY: 101, pointerId: 1 });
    fireEvent.pointerUp(grip, { clientX: 102, clientY: 101, pointerId: 1 });
    expect(calls.filter(c => c.method === 'PATCH')).toEqual([]);
    fireEvent.keyDown(grip, { key: 'ArrowLeft', shiftKey: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save where you moved it. Move it again to try once more.');
  });

  it('puts a bend where a click on a line lands, keeps it, and puts none where the hand drags the map', async () => {
    const calls = mockApi({ 'GET /api/org': [200, ORG_WITH_TEAMS], 'PATCH /api/map/layout': (b: unknown) => [200, b] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Marketing');
    const trace = () => container.querySelector('.wires [data-wire="d1"]')!.getAttribute('d');
    const before = trace();
    const line = container.querySelector<SVGPathElement>('.wires .hit[data-line="dept:d1"]')!;
    expect(line).toHaveTextContent('Click to put a bend in this line');
    fireEvent.pointerDown(line, { clientX: 519, clientY: 260, pointerId: 1, button: 0 });
    fireEvent.pointerUp(line, { clientX: 519, clientY: 260, pointerId: 1 });
    fireEvent.click(line, { clientX: 519, clientY: 260 });
    /* The bend sits on the line, which runs on as it did, with a dot like the one where a trace turns. */
    const bend = screen.getByRole('button', { name: 'Bend in the line: Orchestrator and Marketing. Drag it or use the arrow keys to move it, click it to remove it' });
    expect([parseFloat(bend.style.left), parseFloat(bend.style.top)]).toEqual([516, 260]);
    expect(trace()).toBe(before);
    expect([...container.querySelectorAll('.wires .via')].map(c => `${c.getAttribute('cx')}:${c.getAttribute('cy')}`)).toContain('516:260');
    await waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', path: '/api/map/layout', body: { anchors: { 'dept:d1': [[516, 260]] } } }));
    expect(screen.getByRole('button', { name: 'Put back as it was' })).toBeInTheDocument();
    /* A drag that starts on a line moves the map and puts nothing. */
    const world = container.querySelector<HTMLElement>('.world')!, view = world.style.transform;
    fireEvent.pointerDown(line, { clientX: 516, clientY: 330, pointerId: 2, button: 0 });
    fireEvent.pointerMove(line, { clientX: 546, clientY: 330, pointerId: 2 });
    fireEvent.pointerUp(line, { clientX: 546, clientY: 330, pointerId: 2 });
    fireEvent.click(line, { clientX: 546, clientY: 330 });
    expect(world.style.transform).not.toBe(view);
    expect(screen.getAllByRole('button', { name: /^Bend in the line/ })).toHaveLength(1);
    expect(calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
  });

  it('moves a bend by hand and by the arrow keys, the line and its messages running through it at right angles', async () => {
    const stream = fakeStream();
    const calls = mockApi({
      'GET /api/org': [200, ORG_WITH_TEAMS],
      'GET /api/map/layout': [200, { blocks: {}, anchors: { 'dept:d1': [[516, 260]] } }],
      'PATCH /api/map/layout': (b: unknown) => [200, b],
    });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Marketing');
    const trace = () => container.querySelector('.wires [data-wire="d1"]')!.getAttribute('d');
    const view = container.querySelector<HTMLElement>('.world')!.style.transform;
    const bend = await screen.findByRole('button', { name: /^Bend in the line: Orchestrator and Marketing/ });
    fireEvent.pointerDown(bend, { clientX: 100, clientY: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(bend, { clientX: 80, clientY: 120, pointerId: 1 });
    fireEvent.pointerMove(bend, { clientX: 64, clientY: 140, pointerId: 1 });
    /* The line follows the hand before it lets go, and nothing is kept yet. */
    expect(trace()).toBe('M 600 420 L 480 420 L 480 200 L 390 200');
    expect(calls.filter(c => c.method === 'PATCH')).toEqual([]);
    fireEvent.pointerUp(bend, { clientX: 64, clientY: 140, pointerId: 1 });
    /* The click the browser sends as the hand lets go keeps it there. */
    fireEvent.click(bend, { clientX: 64, clientY: 140, detail: 1 });
    expect(bend.isConnected).toBe(true);
    expect(container.querySelector<HTMLElement>('.world')!.style.transform).toBe(view);
    await waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', path: '/api/map/layout', body: { anchors: { 'dept:d1': [[480, 300]] } } }));
    fireEvent.keyDown(bend, { key: 'ArrowLeft' });
    expect(trace()).toBe('M 600 420 L 470 420 L 470 200 L 390 200');
    await waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', path: '/api/map/layout', body: { anchors: { 'dept:d1': [[470, 300]] } } }));
    stream.send({ type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'd1' } });
    expect(shots(container, 'c').map(s => s.closest<SVGSVGElement>('.pt-box')!.dataset.path)).toEqual(['M 600 420 L 470 420 L 470 200 L 390 200']);
  });

  it('lines a bend up with the next stop of its line as the hand brings it near', async () => {
    mockApi({ 'GET /api/org': [200, ORG_WITH_TEAMS], 'GET /api/map/layout': [200, { blocks: {}, anchors: { 'dept:d1': [[480, 300]] } }], 'PATCH /api/map/layout': (b: unknown) => [200, b] });
    const { container } = render(<MapScreen {...PROPS} />);
    const bend = await screen.findByRole('button', { name: /^Bend in the line: Orchestrator and Marketing/ });
    fireEvent.pointerDown(bend, { clientX: 100, clientY: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(bend, { clientX: 100, clientY: 214, pointerId: 1 });
    /* 6 above the hub's middle line, where the line leaves the hub, the bend comes level with it and the line runs straight out. */
    expect(parseFloat(bend.style.top)).toBe(420);
    expect(container.querySelector('.wires [data-wire="d1"]')!.getAttribute('d')).toBe('M 600 420 L 480 420 L 480 200 L 390 200');
  });

  it('tells the lines how far the map is zoomed, so a line takes a click as wide on the screen at any zoom', async () => {
    mockApi({ 'GET /api/org': [200, ORG_WITH_TEAMS] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Marketing');
    const scale = () => Number(/scale\(([^)]+)\)/.exec(container.querySelector<HTMLElement>('.world')!.style.transform)![1]);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    await waitFor(() => expect(scale()).toBeLessThan(1));
    expect(Number(container.querySelector<SVGElement>('.wires')!.style.getPropertyValue('--k'))).toBe(scale());
  });

  it('takes a bend away with a press that does not move it, or from the keyboard, and the line runs its own way again', async () => {
    const calls = mockApi({
      'GET /api/org': [200, ORG_WITH_TEAMS],
      'GET /api/map/layout': [200, { blocks: {}, anchors: { 'dept:d1': [[480, 300]], 'dept:d2': [[720, 300], [760, 200]] } }],
      'PATCH /api/map/layout': (b: unknown) => [200, b],
    });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Marketing');
    const trace = (id: string) => container.querySelector(`.wires [data-wire="${id}"]`)!.getAttribute('d');
    const home = deptLayout(2).map(s => `M ${s.path.map(p => p.join(' ')).join(' L ')}`);
    const bend = await screen.findByRole('button', { name: /^Bend in the line: Orchestrator and Marketing/ });
    fireEvent.pointerDown(bend, { clientX: 100, clientY: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(bend, { clientX: 101, clientY: 101, pointerId: 1 });
    fireEvent.pointerUp(bend, { clientX: 101, clientY: 101, pointerId: 1 });
    /* It goes with the click that follows, which a finger's tap sends to what is under it then: the bend, not the line. */
    expect(bend.isConnected).toBe(true);
    fireEvent.click(bend, { clientX: 101, clientY: 101, detail: 1 });
    expect(bend.isConnected).toBe(false);
    expect(trace('d1')).toBe(home[0]);
    await waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', path: '/api/map/layout', body: { anchors: { 'dept:d1': null } } }));
    const development = () => screen.queryAllByRole('button', { name: /^Bend in the line: Orchestrator and Development/ });
    expect(development()).toHaveLength(2);
    fireEvent.keyDown(development()[1]!, { key: 'Delete' });
    await waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', path: '/api/map/layout', body: { anchors: { 'dept:d2': [[720, 300]] } } }));
    /* Enter or Space on a bend is a click on it, also after a finger moved it, which sends no click as it lets go. */
    fireEvent.pointerDown(development()[0]!, { clientX: 100, clientY: 100, pointerId: 2, button: 0, pointerType: 'touch' });
    fireEvent.pointerMove(development()[0]!, { clientX: 100, clientY: 140, pointerId: 2, pointerType: 'touch' });
    fireEvent.pointerUp(development()[0]!, { clientX: 100, clientY: 140, pointerId: 2, pointerType: 'touch' });
    fireEvent.keyDown(development()[0]!, { key: 'Enter' });
    fireEvent.click(development()[0]!);
    expect(development()).toEqual([]);
    expect(trace('d2')).toBe(home[1]);
    await waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', path: '/api/map/layout', body: { anchors: { 'dept:d2': null } } }));
  });

  it('puts the bends back with the blocks', async () => {
    const calls = mockApi({
      'GET /api/org': [200, ORG_WITH_TEAMS],
      'GET /api/map/layout': [200, { blocks: {}, anchors: { 'dept:d1': [[480, 300]] } }],
      'DELETE /api/map/layout': [204, undefined],
    });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByRole('button', { name: /^Bend in the line/ });
    fireEvent.click(screen.getByRole('button', { name: 'Put back as it was' }));
    expect(screen.queryByRole('button', { name: /^Bend in the line/ })).toBeNull();
    expect(container.querySelector('.wires [data-wire="d1"]')!.getAttribute('d')).toBe(`M ${deptLayout(2)[0]!.path.map(p => p.join(' ')).join(' L ')}`);
    await waitFor(() => expect(calls).toContainEqual({ method: 'DELETE', path: '/api/map/layout', body: undefined }));
  });

  it("names each bend and what a line offers in the person's language", async () => {
    localStorage.setItem('hh-lang', 'ru');
    onTestFinished(() => localStorage.removeItem('hh-lang'));
    mockApi({ 'GET /api/org': [200, ORG_WITH_TEAMS], 'GET /api/map/layout': [200, { blocks: {}, anchors: { 'dept:d1': [[480, 300]], people: [[600, 150]] } }] });
    const { container } = render(<LanguageProvider><MapScreen {...PROPS} /></LanguageProvider>);
    expect(await screen.findByRole('button', { name: 'Изгиб линии: Оркестратор и Marketing. Перетащите его или двигайте стрелками, нажмите, чтобы убрать' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Изгиб линии: Оркестратор и Руководство компании\./ })).toBeInTheDocument();
    expect(container.querySelector('.wires .hit[data-line="people"]')).toHaveTextContent('Нажмите, чтобы поставить изгиб на этой линии');
  });

  it('sends no pulses while nobody exchanges messages', async () => {
    mockApi({ 'GET /api/org': [200, ORG_WITH_TEAMS] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByText('Marketing');
    expect(container.querySelectorAll('.pt-box, animateMotion')).toHaveLength(0);
  });

  it('moves the dot along the gauge while an agent works', async () => {
    mockApi({ 'GET /api/org': [200, { ...ORG, agents: { total: 1, working: 1 } }] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByTitle('agents working');
    expect(container.querySelector('.hub .pt-box[data-bounce="1"] > circle.pt.k')).toBeInTheDocument();
    expect(container.querySelectorAll('animateMotion')).toHaveLength(0);
  });

  it('keeps a slower work dot on the gauge under reduced motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    mockApi({ 'GET /api/org': [200, { ...ORG, agents: { total: 1, working: 1 } }] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByTitle('agents working');
    expect(container.querySelector('.hub .pt-box[data-bounce="1"] > circle.pt.k')).toBeInTheDocument();
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
    expect(container.querySelectorAll('.map-live .pt-box > circle.pt.a')).toHaveLength(2);
    expect(container.querySelectorAll('.map-live .way-seg')).toHaveLength(0);
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
    const stream = fakeStream();
    let working = true;
    mockApi({ 'GET /api/org': () => [200, {
      ...ORG,
      serverNow: new Date().toISOString(),
      workLines: [{ upstreamAgentId: 'a1', downstreamAgentId: 'h1', working, workEpoch: 1, returnedEpoch: null, returnedAt: null }],
      departments: [dept({ id: 'd1', name: 'Sales', employees: [head('h1')] })],
    }] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByTitle('agents working');
    /* The refresh waits on its timer only as the test moves it. */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => { vi.useRealTimers(); });
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
    /* Every clock of the page moves only when the test moves it. */
    vi.useFakeTimers();
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
    /* The answer comes in without the clock moving: Testing Library's findBy* would wait on a timer of the held clock. */
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText('Sales')).toBeInTheDocument();
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
    await screen.findByTitle('agents working');
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
    await screen.findByTitle('agents working');
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    stream.send({ type: 'pulse', from: { kind: 'person', id: 'p1' }, to: { kind: 'orchestrator' } });
    const dot = container.querySelector('circle.pt')!;
    expect(dot).toBeInTheDocument();
    const box = dot.closest<SVGSVGElement>('.pt-box')!;
    expect(box).toHaveAttribute('data-once', '1');
    const duration = parseFloat(box.dataset.dur!) * 1000;
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
    await screen.findByTitle('agents working');
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
    await screen.findByTitle('agents working');
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
    await screen.findByTitle('agents working');
    hold = true;
    stream.send({ type: 'org' });
    working = 1;
    stream.send({ type: 'org' });
    await vi.waitFor(() => expect(container.querySelector('.hub-num')).toHaveTextContent('1/1'));
    await act(async () => {
      late();
      /* One turn of the event loop: the older answer's promise chain has no timer in it, so it has run its course. */
      await new Promise(r => setImmediate(r));
    });
    expect(container.querySelector('.hub-num')).toHaveTextContent('1/1');
  });

  it('shows what a department works on now where it would say it has no agents', async () => {
    mockApi({ 'GET /api/org': [200, { ...ORG, departments: [dept({ id: 'd1', name: 'Sales', current: { id: 't5', number: 5, title: 'Call ten shops' } }), dept({ id: 'd2', name: 'Support' })] }] });
    render(<MapScreen {...PROPS} />);
    const sales = await screen.findByRole('button', { name: /^Sales/ });
    expect(sales.querySelector('.now')).toHaveTextContent('#5 Call ten shops');
    expect(sales).not.toHaveTextContent('No agents yet');
    expect(screen.getByRole('button', { name: /^Support/ })).toHaveTextContent('No agents yet');
  });

  /* Development and Sales work in turn 3; Operations works all the time and has no strip. */
  const turnOrg = (progress: Record<string, [number, number] | null>) => ({
    ...ORG,
    turn: { id: TURN.id, number: 3, goal: TURN.goal },
    departments: Object.entries(progress).map(([id, p]) =>
      dept({ id, name: id, roleCode: id.slice(0, 3).toUpperCase(), turnProgress: p && { turnNumber: 3, done: p[0], total: p[1] } }),
    ),
  });
  const card = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
  const strip = (name: string) => card(name).querySelector<HTMLElement>('.dept-turn');
  const lit = (bar: Element) => [...bar.querySelectorAll('i')].map(i => i.classList.contains('on'));
  const hubTag = (container: HTMLElement) => container.querySelector('.hub-focus-tag');

  it.each(['en', 'ru'] as const)('shows the turn inside the card of each department that works in it, in %s', async language => {
    localStorage.setItem('hh-lang', language);
    onTestFinished(() => localStorage.removeItem('hh-lang'));
    const calls = mockApi({ 'GET /api/org': [200, turnOrg({ Operations: null, Development: [3, 17], Sales: [0, 4] })] });
    const { container } = render(<LanguageProvider><MapScreen {...PROPS} /></LanguageProvider>);
    const label = language === 'en' ? 'Ready for release: 3' : 'Готово к выпуску: 3';
    const bar = await screen.findByRole('progressbar', { name: label });
    const dev = strip('Development')!;
    expect(dev).toContainElement(bar);
    expect(dev.querySelector('.dt-turn')).toHaveTextContent(language === 'en' ? 'Turn 3' : 'Ход 3');
    expect(dev.querySelector('.dt-cnt')).toHaveTextContent(label);
    expect(bar).toHaveAttribute('aria-valuenow', '18');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(lit(bar)).toEqual([...Array(4).fill(true), ...Array(16).fill(false)]);
    expect(lit(within(strip('Sales')!).getByRole('progressbar'))).toEqual(Array(20).fill(false));
    expect(strip('Operations')).toBeNull();
    /* The strip is part of the card: one button, which opens the department. */
    expect(within(card('Development')).queryAllByRole('button')).toEqual([]);
    /* Every card grows for the strip, so the rows stay even. */
    expect(['Operations', 'Development', 'Sales'].map(n => card(n).style.height)).toEqual(['196px', '196px', '196px']);
    expect(card('Development')).toHaveClass('tall', 'with-turn');
    expect(card('Operations')).toHaveClass('tall');
    expect(card('Operations')).not.toHaveClass('with-turn');
    expect(container.querySelector('.hub-turn')).toBeNull();
    /* The cards take the numbers from the company itself, with no request of their own. */
    expect(calls.some(c => c.path.startsWith('/api/turns'))).toBe(false);
  });

  it('runs one working department along the lower half of the hub in twenty segments, its turn always named', async () => {
    mockApi({ 'GET /api/org': [200, turnOrg({ Operations: null, Development: [3, 17] })] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByRole('progressbar', { name: 'Ready for release: 3' });
    const hub = container.querySelector('.hub')!;
    expect(hub.querySelectorAll('.turn-sec-bg')).toHaveLength(1);
    expect(hub.querySelector('.turn-sec-bg')).toHaveAttribute('d', `M ${arcEnd(174)} A 103 103 0 0 0 ${arcEnd(6)}`);
    expect(hub.querySelector('.turn-sec-bg')).toHaveAttribute('pathLength', '19.72');
    expect(hub.querySelector('.turn-sec-fill')).toHaveAttribute('pathLength', '3.72');
    expect(hub.querySelectorAll('.turn-sec-sep')).toHaveLength(0);
    expect(hub.querySelector('.hub-eq')).toBeInTheDocument();
    expect(hubTag(container)).toHaveTextContent(/^Turn 3$/);
    expect(hub).toHaveClass('has-tag');
    fireEvent.mouseEnter(card('Operations'));
    expect(hubTag(container)).toHaveTextContent(/^Turn 3$/);
  });

  it("shows each department's own turn on its card, and on the hub the turn of the department pointed at", async () => {
    const org = turnOrg({ Development: [3, 17], Sales: [1, 4] });
    org.departments[1] = { ...org.departments[1]!, turnProgress: { turnNumber: 5, done: 1, total: 4 } };
    mockApi({ 'GET /api/org': [200, org] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByRole('progressbar', { name: 'Ready for release: 3' });
    expect(strip('Development')!.querySelector('.dt-turn')).toHaveTextContent('Turn 3');
    expect(strip('Sales')!.querySelector('.dt-turn')).toHaveTextContent('Turn 5');
    /* The hub holds every running turn together, a sector for each. */
    expect(container.querySelectorAll('.hub .turn-sec')).toHaveLength(2);
    fireEvent.mouseEnter(card('Sales'));
    expect(hubTag(container)).toHaveTextContent(/^SAL · Turn 5$/);
  });

  it('gives each working department a sector of its own, lit when its card is pointed at or focused', async () => {
    mockApi({ 'GET /api/org': [200, turnOrg({ Development: [3, 17], Operations: null, Sales: [4, 4], Marketing: [1, 2] })] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByRole('progressbar', { name: 'Ready for release: 3' });
    const hub = container.querySelector('.hub')!;
    const sectors = [...hub.querySelectorAll('.turn-sec')];
    expect(sectors.map(s => s.getAttribute('data-dept'))).toEqual(['Development', 'Sales', 'Marketing']);
    expect(sectors.map(s => s.querySelector('.turn-sec-bg')!.getAttribute('pathLength'))).toEqual(['5.72', '5.72', '5.72']);
    expect(sectors.map(s => s.querySelector('.turn-sec-fill')?.getAttribute('pathLength') ?? null)).toEqual(['0.72', '5.72', '2.72']);
    expect(hub.querySelectorAll('.turn-sec-sep')).toHaveLength(2);
    /* At rest the hub adds up nothing: no tag, no share of all. */
    expect(hubTag(container)).toBeNull();
    expect(hub).not.toHaveTextContent('%');
    fireEvent.mouseEnter(card('Sales'));
    expect(hubTag(container)).toHaveTextContent(/^SAL · Turn 3$/);
    expect(sectors.map(s => s.getAttribute('class'))).toEqual(['turn-sec dim', 'turn-sec active', 'turn-sec dim']);
    fireEvent.mouseLeave(card('Sales'));
    expect(hubTag(container)).toBeNull();
    expect(sectors.map(s => s.getAttribute('class'))).toEqual(['turn-sec', 'turn-sec', 'turn-sec']);
    fireEvent.focus(card('Marketing'));
    expect(hubTag(container)).toHaveTextContent(/^MAR · Turn 3$/);
    fireEvent.blur(card('Marketing'));
    fireEvent.focus(card('Operations'));
    expect(hubTag(container)).toBeNull();
  });

  it.each([
    ['no department works in the turn', { Development: null, Sales: null }],
    ['the turn gave the departments no tasks', { Development: [0, 0], Sales: [0, 0] }],
  ] as const)('keeps the cards and the hub as they were when %s', async (_, progress) => {
    mockApi({ 'GET /api/org': [200, turnOrg(progress as Record<string, [number, number] | null>)] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByTitle('agents working');
    expect(container.querySelector('.dept-turn')).toBeNull();
    expect(card('Development').style.height).toBe('160px');
    expect(card('Development')).not.toHaveClass('tall');
    expect(container.querySelector('.turn-sec-bg, .turn-sec-fill, .hub-eq')).toBeNull();
    expect(hubTag(container)).toBeNull();
    expect(container.querySelector('.hub')).not.toHaveClass('has-tag');
  });

  it('follows the tasks of the turn live, and lets the strip go when the turn closes', async () => {
    const stream = fakeStream();
    let progress: [number, number] | null = [3, 17];
    mockApi({ 'GET /api/org': () => [200, turnOrg({ Development: progress, Operations: null })] });
    const { container } = render(<MapScreen {...PROPS} />);
    await screen.findByRole('progressbar', { name: 'Ready for release: 3' });
    progress = [4, 17];
    stream.send({ type: 'task' });
    const bar = await screen.findByRole('progressbar', { name: 'Ready for release: 4' });
    expect(bar).toHaveAttribute('aria-valuenow', '24');
    expect(lit(bar).filter(Boolean)).toHaveLength(5);
    progress = [1000, 1000];
    stream.send({ type: 'task' });
    expect(await screen.findByRole('progressbar', { name: 'Ready for release: 1000' })).toHaveAttribute('aria-valuenow', '100');
    expect(container.querySelector('.turn-sec-fill')).toHaveAttribute('pathLength', '19.72');
    progress = null;
    stream.send({ type: 'org' });
    await waitFor(() => expect(container.querySelector('.dept-turn')).toBeNull());
    expect(container.querySelector('.turn-sec-bg, .hub-eq, .hub-focus-tag')).toBeNull();
    expect(card('Development').style.height).toBe('160px');
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
      expect(shots(container, 'c')[0]!.closest<SVGSVGElement>('.pt-box')!.dataset.path).toBe('M 70 200 L 110 200');
      stream.send({ type: 'pulse', from: { kind: 'department', id: 'd1' }, to: { kind: 'person', id: 'p4' } });
      expect(shots(container, 'a')).toHaveLength(1);
      expect(shots(container, 'a')[0]!.closest<SVGSVGElement>('.pt-box')!.dataset.path).toBe('M 110 200 L 70 200');
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
      await screen.findByTitle('agents working');
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
    expect(shots(container, 'a')[0]!.closest('[data-mask]')).toHaveAttribute('data-mask', mask);
    expect(container.querySelectorAll('.map-live .way-seg').length).toBeGreaterThan(3);
  });
});

/* #1580: words are Japanese when they hold hiragana or katakana, which only Japanese writes. Kanji alone may be Chinese, and
   Latin letters are any language: the page's language speaks for them. */
describe('writtenIn', () => {
  it.each([
    ['財務と経理の責任者', 'ja'],
    ['レナ', 'ja'],
    ['ブルーノ・ロッシ', 'ja'],
    ['最高経営責任者', undefined],
    ['开发部负责人', undefined],
    ['Lena', undefined],
    ['Финансы', undefined],
    ['', undefined],
  ])('%s is %s', (words, lang) => expect(writtenIn(words)).toBe(lang));
});

describe('deptLayout', () => {
  it('routes every department at right angles from the hub to the middle of its near side, without overlaps', () => {
    const spots = deptLayout(7);
    const [hx, hy] = spots[0]!.path[0]!;
    for (const s of spots) {
      const [start, ...rest] = s.path;
      expect(start).toEqual([hx, hy]);
      /* Every step runs straight across or down, the first one under the hub too: no line on the map is diagonal. */
      let prev = start!;
      for (const p of rest) {
        expect(p[0] === prev[0] || p[1] === prev[1], JSON.stringify(s.path)).toBe(true);
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

  it('makes the cards taller for a turn strip and keeps 32 between rows that would come closer', () => {
    const tall = (n: number) => {
      const spots = deptLayout(n, 196);
      const hy = spots[0]!.path[0]![1];
      return { spots, rows: [...new Set(spots.map(s => s.y + s.h / 2 - hy))] };
    };
    expect(tall(4).rows).toEqual([-220, 220]);
    expect(tall(6).rows).toEqual([-228, 0, 228]);
    expect(tall(12).rows).toEqual([-570, -342, -114, 114, 342, 570]);
    expect(tall(5).spots.map(s => [s.w, s.h])).toEqual(Array(5).fill([280, 196]));
    for (const n of [2, 5, 6, 12]) {
      const { spots } = tall(n);
      for (const a of spots)
        for (const b of spots)
          if (a !== b && a.x === b.x) expect(Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h)).toBeGreaterThanOrEqual(32);
    }
  });
});
