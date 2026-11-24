import { taskRoute } from './task-route';
import { unisolated } from './bidi';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LANGUAGES, LanguageProvider, type ShippedLanguage, type Messages } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { Shell } from '../src/screens/Shell';
import { DepartmentView, READABLE_K, schemaView } from '../src/screens/Department';
import { schemaLayout, stepPaths } from '../src/screens/schema';
import { RepoSettings } from '../src/ui/RepoSettings';
import { localPipeline, useDepartmentTree } from '../src/tasks';
import { toD } from '../src/ui/wires';
import type { DepartmentTree, Employee, Me, Org, ProgramView } from '../src/types';
import { CARD, decisions, DEV_ORG, DEV_TREE, REVIEW_TREE, TREE_ORG, ME, mockApi, REQUESTS, ROSTER, TASKS } from './api-mock';
import { decl, px, rulesFor } from './css';
import { fakeStream } from './fake-stream';

/* The dots that keep running along one way of the department's schema. */
const runningDots = (tone: 'c' | 'a', d: string) =>
  [...document.querySelectorAll(`.dview circle.pt.${tone} animateMotion`)].filter(m => m.getAttribute('path') === d && m.getAttribute('repeatCount') === 'indefinite');

const EVENTS = '/api/agents/orchestrator/events?last=300';
const READY = { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 };
const DEV_TASKS = 'GET /api/tasks?status=open&department=d2';
const REPO = { url: 'https://github.com/acme/app.git', branch: 'main', tokenLast4: '1234' };
/* Lena reaches Development by its own line in her access; Kira reaches only Sales. */
const LENA = { id: 'p6', name: 'Lena', email: 'lena@acme.com', title: 'Product lead', status: 'active' as const, isOwner: false, access: { whole: false, departments: [{ id: 'd2', name: 'Development' }], teams: [] } };
const listed = (id: string, name: string): Me => ({ ...ME, person: { ...ME.person, id, name, scopeKind: 'listed', isOwner: false } });

const messages: Record<ShippedLanguage, Messages> = { en, ru };
/* The shortest and the longest shipped language by the words of a route, and every right to left one. */
const routeLocales = LANGUAGES.map(({ id }) => {
  const route = messages[id].pipelineCatalog['development-changes'];
  return { id, length: [route.name, ...Object.values(route.stages)].join('').length };
}).sort((a, b) => a.length - b.length);
const checkedLocales = [...new Set([routeLocales[0]!.id, routeLocales.at(-1)!.id,
  ...LANGUAGES.map(({ id }) => id).filter(id => /^(ar|fa|he|ur)(-|$)/.test(id))])];

function shell(routes: Record<string, unknown> = {}, org: Org = DEV_ORG, me: Me = ME) {
  const calls = mockApi({
    'GET /api/org': [200, org],
    'GET /api/agents/orchestrator': [200, { ...CARD, id: 'a1', kind: 'orchestrator', name: 'Orchestrator', role: null, department: null }],
    [`GET ${EVENTS}`]: [200, { events: [], state: READY }],
    'POST /api/agents/orchestrator/start': [200, { started: false }],
    ...(routes as Record<string, [number, unknown]>),
  });
  render(
    <LanguageProvider>
      <Shell me={me} onSignOut={() => {}} />
    </LanguageProvider>,
  );
  return calls;
}

async function flyIn(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /^Development/ }));
  return screen.findByRole('heading', { level: 2, name: 'Development' });
}

/* The department's tasks, or its repository, products and people, in the drawer at the left. */
const drawer = (user: ReturnType<typeof userEvent.setup>, name: 'Department tasks' | 'About the department') => user.click(screen.getByRole('button', { name }));

describe('Department view', () => {
  it('marks generalists in the diagram and in the department staff list', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const team = { id: 'u1', name: 'Whole tasks', about: '', stage: 0, gate: false, turnkey: true };
    const department = { ...dev!, teams: [team], employees: dev!.employees.map(e => e.id === 'b1' ? { ...e, teamId: team.id, turnkey: true } : e) };
    shell({}, { ...DEV_ORG, departments: [department] });
    await flyIn(user);
    const schema = screen.getByRole('region', { name: 'Department schema' });
    const generalist = 'Generalist: does a task whole';
    expect(within(schema).getByText('Bruno').closest('button')?.querySelector(`[title="${generalist}"]`)).toHaveAttribute('data-worker-kind', 'generalist');
    await drawer(user, 'About the department');
    const staff = within(screen.getByRole('complementary', { name: 'About the department' })).getByRole('region', { name: 'Members' });
    expect(within(staff).getByRole('img', { name: generalist }).querySelector('svg rect')).toBeInTheDocument();
  });

  it('lights fixed call places in their own pipeline card as the org feed changes', async () => {
    const stream = fakeStream();
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const oneShotStages = [
      { stage: 'review', ownerRole: 'DEV-REV', gate: 1, fanOut: 3, judge: true },
      { stage: 'security', ownerRole: 'DEV-SEC', gate: 2, fanOut: 1, judge: false },
    ];
    const call = { task: 12, by: 'b1', stage: 'review', judge: false, startedAt: null };
    const active = [
      { ...call, id: 'queued', number: 1 },
      { ...call, id: 'running', number: 1, task: 13, startedAt: '2026-11-17T10:00:00.000Z' },
      { ...call, id: 'judge', number: 4, judge: true },
      { ...call, id: 'ad-hoc', number: 2, stage: null },
    ];
    let calls: typeof active = [];
    /* The department's default route carries its one-shot stages; the schema draws one frame of diamonds for each. */
    const pipelines = [{ id: 'r1', department: { id: dev!.id, name: 'Development' }, name: 'Software changes', why: '', archived: false, isDefault: true, version: 1,
      stages: oneShotStages.map((s, i) => ({ id: `s${i}`, parentId: null, name: s.stage, ownerRole: s.ownerRole, owner: null, position: i, echelon: s.stage, oneShot: { fanOut: s.fanOut, judge: s.judge } })) }];
    shell({ 'GET /api/org': () => [200, { ...DEV_ORG, departments: [{ ...dev!, pipelines, calls }] }] });
    await flyIn(user);
    const schema = screen.getByRole('region', { name: 'Department schema' });
    const review = within(schema).getByRole('group', { name: 'Review' });
    const marks = () => within(review).getAllByRole('img', { name: /^One-shot call: starts from zero each time, no memory/ });
    const diamonds = marks();
    expect(diamonds).toHaveLength(4);
    expect(diamonds.every(mark => mark.querySelector('path[d="M8 1 15 8 8 15 1 8Z"]'))).toBe(true);
    expect(diamonds[3]).toHaveAccessibleName(/Judge call.*Idle/i);
    expect(within(within(schema).getByRole('group', { name: 'Security' })).getAllByRole('img')).toHaveLength(1);
    expect(within(within(schema).getByRole('group', { name: 'Backend engineer' })).queryByRole('img', { name: /one-shot call/i })).toBeNull();

    calls = active;
    await act(async () => stream.send({ type: 'org' }));
    expect(marks()).toEqual(diamonds);
    expect(diamonds[0]).toHaveClass('running');
    expect(diamonds[0]).toHaveAccessibleName(/Call 1.*Running/);
    expect(diamonds[1]).toHaveClass('idle');
    expect(diamonds[2]).toHaveClass('idle');
    expect(diamonds[3]).toHaveClass('waiting');
    expect(diamonds[3]).toHaveAttribute('title', 'One-shot call: starts from zero each time, no memory. Judge call. Waiting');

    calls = [];
    await act(async () => stream.send({ type: 'org' }));
    expect(marks()).toEqual(diamonds);
    expect(diamonds.every(mark => mark.classList.contains('idle'))).toBe(true);
  });

  /* 0.34.2 took the department structure list away: a department with routes opens on its staff schema, and no switch
     leads to a list of its routes and stages (#1477). */
  it('opens a department with routes on its staff schema, with no structure list to switch to', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const build = { id: 'build', parentId: null, name: 'Build the change', ownerRole: 'DEV-BE', owner: null, position: 0, echelon: 'development' };
    const pipelines = [{ id: 'r1', department: { id: dev!.id, name: 'Development' }, name: 'Software changes', why: '', archived: false, isDefault: true, version: 1, stages: [build] }];
    shell({ 'GET /api/org': () => [200, { ...DEV_ORG, departments: [{ ...dev!, pipelines }] }] });
    await flyIn(user);
    expect(screen.getByRole('region', { name: 'Department schema' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Department structure' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Software changes' })).toBeNull();
    expect(screen.queryByText('Build the change')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Staff map' })).toBeNull();
  });

  it.each(checkedLocales)('names the video draft, keeper and edit stages in %s', language => {
    const [dev] = DEV_ORG.departments;
    const draft = { id: 'draft', parentId: null, name: 'Generate draft shots', ownerRole: 'VID-GEN', owner: null, position: 0, oneShot: { fanOut: 2, judge: true } };
    const keeper = { id: 'keeper', parentId: draft.id, name: 'Check shot continuity', ownerRole: 'VID-KEEP', owner: null, position: 1 };
    const edit = { id: 'edit', parentId: keeper.id, name: 'Edit the draft cut', ownerRole: 'VID-EDIT', owner: null, position: 2 };
    const pipeline = { id: 'video', department: { id: dev!.id, name: 'Video production' }, catalogKey: 'video-production', name: 'Video production',
      why: '', archived: false, version: 1, isDefault: true, stages: [draft, keeper, edit] };
    const copy = {
      en: ['Video production', 'Generate draft shots', 'Check shot continuity', 'Edit the draft cut'],
      ru: ['Производство видео', 'Создать черновые кадры', 'Проверить согласованность кадров', 'Смонтировать черновик'],
    }[language];
    const local = localPipeline(messages[language], pipeline);
    expect([local.name, ...local.stages.map(stage => stage.name)]).toEqual(copy);
  });

  it.each(checkedLocales)('localizes the long video pipeline and its use in %s', language => {
    localStorage.setItem('hh-lang', language);
    const [dev] = DEV_ORG.departments;
    const copy = {
      en: {
        name: 'Long video production', why: 'For a film, a series or a work with many scenes or places.',
        stages: ['Write the brief', 'Write the story and make a production guide', 'Break down sequences and scenes', 'Prove the hardest moment',
          'Make the scenes', 'Assemble the cut', 'Finish color, sound and titles', 'Check the whole work', 'Prepare and deliver the final version'],
      },
      ru: {
        name: 'Производство длинного видео', why: 'Для фильма, сериала или видео с множеством сцен или мест действия.',
        stages: ['Написать задание', 'Написать историю и собрать справочник', 'Разбить историю на эпизоды и сцены', 'Проверить самый сложный момент',
          'Сделать сцены', 'Собрать монтаж', 'Доработать цвет, звук и титры', 'Проверить всю работу', 'Подготовить и передать финальную версию'],
      },
    };
    const pipeline = { id: 'long-video', department: { id: dev!.id, name: 'Video production' }, catalogKey: 'video-long-work',
      name: copy.en.name, why: copy.en.why, archived: false, version: 1,
      stages: copy.en.stages.map((name, position) => ({ id: String(position), parentId: position ? String(position - 1) : null, name, position, ownerRole: null, owner: null })) };
    const local = localPipeline(messages[language], pipeline);
    expect(local.why).toBe(copy[language].why);
    expect(local.name).toBe(copy[language].name);
    expect(local.stages.map(stage => stage.name)).toEqual(copy[language].stages);
  });

  /* On a right to left page the dot of "No head yet." and of the map's hint stays at the end of the words (Design #1186). */
  it('keeps the words of a department with no head and no employees in their own direction', () => {
    mockApi({});
    const { container } = render(<LanguageProvider><DepartmentView me={ME} department={{ ...DEV_ORG.departments[0]!, employees: [] }} deputies={[]} selected={null}
      panel="task" onBack={() => {}} onHire={() => {}} onOpen={() => {}} onOpenTask={() => {}} /></LanguageProvider>);
    const head = container.querySelector<HTMLElement>('.shead.empty')!;
    expect(head).toHaveTextContent('No head yet.');
    const hint = screen.getByText('No employees yet. Hire them through the orchestrator.');
    expect([...unisolated(head), ...unisolated(hint)]).toEqual([]);
    /* Its count of agents and roles is one phrase in its own direction, the numbers inside it (Design #1201). */
    const counts = within(head).getByText(/^0 of 0 agents working, \d+ roles?$/);
    expect(counts).toHaveAttribute('dir', 'auto');
  });

  it.each(['task', 'window'] as const)('fits the schema clear of the %s panel on its own side', panel => {
    mockApi({});
    render(<LanguageProvider><DepartmentView me={ME} department={DEV_ORG.departments[0]!} deputies={[]} selected={null}
      panel={panel} onBack={() => {}} onHire={() => {}} onOpen={() => {}} onOpenTask={() => {}} /></LanguageProvider>);
    const canvas = screen.getByRole('region', { name: 'Department schema' });
    Object.defineProperties(canvas, { clientWidth: { value: 1440 }, clientHeight: { value: 900 } });
    fireEvent.click(screen.getByRole('button', { name: 'Show everything' }));
    const world = canvas.querySelector<HTMLElement>('.world')!;
    const match = /translate\(([^p]+)px, [^p]+px\) scale\(([^)]+)\)/.exec(world.style.transform)!;
    const x = Number(match[1]), k = Number(match[2]);
    expect(x).toBeGreaterThanOrEqual(panel === 'window' ? 0 : 432);
    expect(x + parseFloat(world.style.width) * k).toBeLessThanOrEqual(panel === 'window' ? 752 : 1440);
  });

  it.each([
    ['en', 'final_check', 'final turn check, once per turn'],
    ['en', 'observer', 'turn observer'],
    ['en', undefined, 'Builds the server side.'],
    ['ru', 'final_check', 'финальная проверка хода, один раз за ход'],
    ['ru', 'observer', 'наблюдатель хода'],
    ['ru', undefined, 'Делает серверную часть.'],
  ] as const)('describes the %s %s role frame', (language, schema, description) => {
    localStorage.setItem('hh-lang', language);
    const department = DEV_ORG.departments[0]!;
    const role = { ...department.roles[1]!, schema };
    mockApi({});
    render(<LanguageProvider><DepartmentView me={ME} department={{ ...department, roles: [department.roles[0]!, role] }}
      deputies={[]} selected={null} panel={null} onBack={() => {}} onHire={() => {}}
      onOpen={() => {}} onOpenTask={() => {}} /></LanguageProvider>);
    expect(screen.getByText(description)).toBeInTheDocument();
  });

  it.each([
    ['en', ['Review', 'Security']],
    ['ru', ['Проверка', 'Безопасность']],
  ] as const)('names the %s call frames by their stage in the language of the screen', (language, names) => {
    localStorage.setItem('hh-lang', language);
    onTestFinished(() => localStorage.removeItem('hh-lang'));
    const department = DEV_ORG.departments[0]!;
    const stages = [['review', 'DEV-REV'], ['security', 'DEV-SEC']] as const;
    const pipelines = [{ id: 'r1', department: { id: department.id, name: 'Development' }, name: 'Software changes', why: '', archived: false, isDefault: true, version: 1,
      stages: stages.map(([stage, ownerRole], i) => ({ id: `s${i}`, parentId: null, name: stage, ownerRole, owner: null, position: i, echelon: stage, oneShot: { fanOut: 1, judge: false } })) }];
    mockApi({});
    render(<LanguageProvider><DepartmentView me={ME} department={{ ...department, pipelines, calls: [] }}
      deputies={[]} selected={null} panel={null} onBack={() => {}} onHire={() => {}}
      onOpen={() => {}} onOpenTask={() => {}} /></LanguageProvider>);
    for (const name of names) expect(screen.getByRole('group', { name })).toHaveClass('frame-calls');
  });

  /* A text a language lacks reads in English: a role whose template has no Russian words still names its frame. */
  it('names a role frame and tells what the role does in English where the role has no text in the language of the screen', async () => {
    localStorage.setItem('hh-lang', 'ru');
    onTestFinished(() => localStorage.removeItem('hh-lang'));
    const department = DEV_ORG.departments[0]!;
    const bruno = department.employees.find(e => e.id === 'b1')!;
    const reviewer = { id: 'DEV-REV', title: { en: 'Code reviewer' }, description: { en: 'Reviews every change.' }, kind: 'member' as const, gate: 1 };
    const rita = { ...bruno, id: 'b2', name: 'Rita', roleId: 'DEV-REV', title: { en: 'Code reviewer' } };
    mockApi({});
    render(<LanguageProvider><DepartmentView me={ME} department={{ ...department, roles: [...department.roles, reviewer], employees: [...department.employees, rita] }}
      deputies={[]} selected={null} panel={null} onBack={() => {}} onHire={() => {}}
      onOpen={() => {}} onOpenTask={() => {}} /></LanguageProvider>);
    const frame = await screen.findByRole('group', { name: 'Code reviewer' });
    expect(frame.querySelector('.fn')).toHaveTextContent('Code reviewer');
    expect(frame.querySelector('.fa')).toHaveTextContent('Reviews every change.');
  });

  /* A department that keeps no repository, nor any of its products, hands its work in as documents: its call frames read the
     plain stage names its task workflows read, never the names of code. */
  it.each([
    ['en', ['Plan', 'Work', 'Check', 'Risk check'], ['Architecture', 'Development', 'Review', 'Security']],
    ['ru', ['План', 'Работа', 'Проверка', 'Проверка риска'], ['Архитектура', 'Разработка', 'Безопасность']],
  ] as const)('names the %s call frames of a document department by the plain stage names', (language, names, codeNames) => {
    localStorage.setItem('hh-lang', language);
    onTestFinished(() => localStorage.removeItem('hh-lang'));
    const department = DEV_ORG.departments[0]!;
    const stages = ['architecture', 'development', 'review', 'security'] as const;
    const pipelines = [{ id: 'r1', department: { id: department.id, name: 'Development' }, name: 'Texts', why: '', archived: false, isDefault: true, version: 1,
      stages: stages.map((stage, i) => ({ id: `s${i}`, parentId: null, name: stage, ownerRole: null, owner: null, position: i, echelon: stage, oneShot: { fanOut: 1, judge: false } })) }];
    mockApi({});
    render(<LanguageProvider><DepartmentView me={ME} department={{ ...department, keepsRepository: false, pipelines, calls: [] }}
      deputies={[]} selected={null} panel={null} onBack={() => {}} onHire={() => {}}
      onOpen={() => {}} onOpenTask={() => {}} /></LanguageProvider>);
    for (const name of names) expect(screen.getByRole('group', { name })).toHaveClass('frame-calls');
    for (const name of codeNames) expect(screen.queryByRole('group', { name })).toBeNull();
  });

  it('keeps the names of code on the call frames of a department whose product keeps a repository', () => {
    const department = DEV_ORG.departments[0]!;
    const pipelines = [{ id: 'r1', department: { id: department.id, name: 'Development' }, name: 'Software changes', why: '', archived: false, isDefault: true, version: 1,
      stages: [{ id: 's0', parentId: null, name: 'development', ownerRole: null, owner: null, position: 0, echelon: 'development' as const, oneShot: { fanOut: 1, judge: false } }] }];
    mockApi({});
    render(<LanguageProvider><DepartmentView me={ME} department={{ ...department, keepsRepository: true, repository: null, pipelines, calls: [] }}
      deputies={[]} selected={null} panel={null} onBack={() => {}} onHire={() => {}}
      onOpen={() => {}} onOpenTask={() => {}} /></LanguageProvider>);
    expect(screen.getByRole('group', { name: 'Development' })).toHaveClass('frame-calls');
    expect(screen.queryByRole('group', { name: 'Work' })).toBeNull();
  });

  it('flies into a department and shows its head and members', async () => {
    const user = userEvent.setup();
    shell();
    await flyIn(user);
    const head = screen.getByRole('region', { name: 'Head' });
    expect(within(head).getByRole('button', { name: /Dana/ })).toHaveTextContent('Head of development');
    expect(within(head).getByText('working')).toBeInTheDocument();
    expect(head).toHaveTextContent('1 of 2 agents working, 1 role');
    const members = screen.getByRole('region', { name: 'Members' });
    const bruno = within(members).getByRole('button', { name: /Bruno/ });
    expect(bruno).toHaveTextContent('Claude Sonnet 5.5');
    expect(bruno).toHaveTextContent('Anthropic');
    expect(bruno).toHaveTextContent('free');
    expect(bruno).toHaveTextContent('Waiting for a new task');
    const schema = screen.getByRole('region', { name: 'Department schema' });
    expect(within(schema).getByText('Backend engineer')).toBeInTheDocument();
    expect(within(schema).getByText('1 agent')).toBeInTheDocument();
    expect(within(schema).getByText('Sasha')).toBeInTheDocument();
    await drawer(user, 'About the department');
    expect(within(screen.getByRole('region', { name: 'Products' })).getByText('Mascot')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'People with access' })).getByText('Sasha')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to the map' }));
    expect(screen.queryByRole('heading', { level: 2, name: 'Development' })).not.toBeInTheDocument();
  });

  it('keeps the back button separate from the department caption plaque', async () => {
    const user = userEvent.setup();
    shell();
    const title = await flyIn(user);
    const bar = screen.getByRole('navigation', { name: 'Development' });
    const back = within(bar).getByRole('button', { name: 'Back to the map' });
    const plaque = title.closest('.crumb') as HTMLElement;
    expect(within(bar).getAllByRole('button')).toEqual([back]);
    expect(bar).not.toHaveClass('glass');
    expect(back).toHaveClass('hbtn', 'glass', 'ib');
    expect(back).toHaveAttribute('title', 'Back to the map');
    expect(back).toHaveTextContent('');
    expect(plaque).not.toBe(back);
    expect(plaque.tagName).toBe('DIV');
    expect(plaque).toHaveClass('crumb', 'glass');
    expect(plaque).toContainElement(title);
    expect(plaque).toContainElement(within(bar).getByText('CTO'));
    expect(decl('.crumb', 'cursor')).toBeUndefined();
    await user.click(within(bar).getByText('CTO'));
    expect(screen.getByRole('heading', { level: 2, name: 'Development' })).toBeInTheDocument();
    await user.click(back);
    expect(screen.queryByRole('heading', { level: 2, name: 'Development' })).not.toBeInTheDocument();
  });

  it('names an employee once when it is called after its role', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    shell({}, { ...DEV_ORG, departments: [{ ...dev!, employees: [{ ...dev!.employees[0]!, name: 'Head of development' }] }] });
    await flyIn(user);
    const head = within(screen.getByRole('region', { name: 'Head' })).getByRole('button');
    expect(head.textContent!.match(/Head of development/g)).toHaveLength(1);
  });

  it('lists the deputies who reach the department among the people with access', async () => {
    const user = userEvent.setup();
    const oleg = { id: 'p4', name: 'Oleg', email: 'oleg@acme.com', title: 'Art director', status: 'invited' as const, isOwner: false, deputy: true, access: { whole: false, departments: [{ id: 'd2', name: 'Development' }, { id: 'd9', name: 'Design' }], teams: [] } };
    const away = { ...oleg, id: 'p5', name: 'Lena', access: { whole: false, departments: [{ id: 'd8', name: 'Sales' }, { id: 'd9', name: 'Design' }], teams: [] } };
    shell({}, { ...DEV_ORG, people: [...DEV_ORG.people, oleg, away] });
    await flyIn(user);
    await drawer(user, 'About the department');
    const people = screen.getByRole('region', { name: 'People with access' });
    expect(within(people).getAllByRole('listitem').map(li => li.querySelector('b')!.textContent)).toEqual(['Sasha', 'Oleg']);
  });

  it("opens a person's decisions from their card in the department, which shows the same count as the map", async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const sasha = { ...dev!.people[0]!, pendingDecisions: 2 };
    shell({
      'GET /api/requests': [200, decisions([{ ...REQUESTS[0]!, ownerPersonId: sasha.id }, { ...REQUESTS[1]!, ownerPersonId: sasha.id }])],
      'GET /api/tasks?status=all': [200, { tasks: TASKS }],
      'GET /api/turns': [200, { turns: [] }],
    }, { ...DEV_ORG, departments: [{ ...dev!, people: [sasha] }] });
    await flyIn(user);
    const schema = screen.getByRole('region', { name: 'Department schema' });
    const card = within(schema).getByRole('button', { name: 'Sasha: 2 decisions wait' });
    expect(card).toHaveClass('attn');
    expect(card).toHaveTextContent('2');
    await user.click(card);
    expect(await screen.findByRole('heading', { level: 1, name: 'Waits for Sasha' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'View as' })).toHaveValue('p3');
    expect(screen.getByRole('region', { name: 'Waiting for you' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'Development' })).not.toBeInTheDocument();
  });

  it('shows an employee start working while the department is open', async () => {
    const stream = fakeStream();
    const [dev] = DEV_ORG.departments;
    const task = { id: 't12', number: 12, title: 'Checkout API', echelons: taskRoute() };
    const busy: Org = { ...DEV_ORG, departments: [{ ...dev!, employees: dev!.employees.map(e => ({ ...e, state: 'working' as const, status: 'working' as const, task })) }] };
    let started = false;
    await act(async () => {
      shell({ 'GET /api/org': () => [200, started ? busy : DEV_ORG] });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Development/ }));
    });
    expect(screen.getByRole('heading', { level: 2, name: 'Development' })).toBeInTheDocument();
    const bruno = within(screen.getByRole('region', { name: 'Members' })).getByRole('button', { name: /Bruno/ });
    expect(bruno).toHaveTextContent('free');
    expect(screen.getByText('Work goes left to right through the gates. Whoever leads a stage now is marked in its role.')).toBeInTheDocument();
    started = true;
    await act(async () => {
      stream.send({ type: 'working', working: 2 });
    });
    expect(within(screen.getByRole('region', { name: 'Members' })).getByRole('button', { name: /Bruno/ })).toHaveTextContent('BrunoClaudeworkingClaude Sonnet 5.5, default effort, AnthropicDevelopment #12 Checkout API');
    /* The line at the bottom says what changed last. */
    expect(screen.getByText('Bruno: working, #12 Checkout API')).toBeInTheDocument();
  });

  it("shows how full each agent's context is on its card, and follows it live", async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    const [dev] = DEV_ORG.departments;
    const [dana, bruno] = dev!.employees;
    shell({}, { ...DEV_ORG, departments: [{ ...dev!, employees: [{ ...dana!, context: 0.75 }, { ...bruno!, context: null }] }] });
    await flyIn(user);
    const head = screen.getByRole('region', { name: 'Head' });
    expect(within(head).getByTitle('Context 75%')).toHaveClass('bar', 'hi');
    expect(head).toHaveTextContent('Context75%');
    const members = screen.getByRole('region', { name: 'Members' });
    expect(within(members).queryByTitle(/^Context/)).not.toBeInTheDocument();
    stream.send({ type: 'context', agentId: 'b1', used: 0.93 });
    expect(within(members).getByTitle('Context 93%')).toHaveClass('bar', 'max');
    stream.send({ type: 'context', agentId: 'b1', used: 0.2 });
    expect(within(members).getByTitle('Context 20%')).not.toHaveClass('hi');
  });

  it("draws the line from the head to an employee blue while it works on the head's task, from card to card", async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const lines = [{ upstreamAgentId: 'b0', downstreamAgentId: 'b1', working: true, workEpoch: 1, returnedEpoch: null, returnedAt: null }];
    shell({}, { ...DEV_ORG, serverNow: new Date().toISOString(), departments: [{ ...dev!, workLines: lines }] });
    await flyIn(user);
    const work = document.querySelector('.wires path[data-work="b1"]');
    /* Dashes run from inside the head's card down the bus and the role's spine into the employee's, with two dots on them. */
    expect(work).toHaveClass('tr', 'live', 'c');
    const d = toD(stepPaths(schemaLayout(dev!, 1)).toMember('b1')!);
    expect(work!.getAttribute('d')).toBe(d);
    expect(runningDots('c', d)).toHaveLength(2);
  });

  it('draws a yellow result on the real employee-to-head path without a gate return', async () => {
    /* The page's steady clock stands still, so the result 4.5 minutes old stays inside its five yellow minutes. */
    vi.useFakeTimers({ toFake: ['performance'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const now = Date.now();
    const lines = [{ upstreamAgentId: 'b0', downstreamAgentId: 'b1', working: false, workEpoch: 4, returnedEpoch: 4, returnedAt: new Date(now - 4.5 * 60_000).toISOString() }];
    const org = { ...DEV_ORG, serverNow: new Date(now).toISOString(), departments: [{ ...dev!, workLines: lines }] };
    shell({}, org);
    await flyIn(user);
    const path = stepPaths(schemaLayout(org.departments[0]!, 1)).toMember('b1');
    expect(document.querySelector('.dview .wires path.live.a')).toHaveAttribute('d', toD([...path!].reverse()));
    expect(document.querySelector('.dview .wires path.live.a')).toHaveAttribute('data-work', 'b1');
    expect(document.querySelectorAll('.dview .rl')).toHaveLength(0);
  });

  it.each([false, true])('runs a message dot until arrival, reduced motion %s', async reduce => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduce && query.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
    const user = userEvent.setup();
    const stream = fakeStream();
    const [dev] = DEV_ORG.departments;
    shell();
    await flyIn(user);
    vi.useFakeTimers();
    try {
      stream.send({ type: 'pulse', from: { kind: 'agent', id: 'b0', departmentId: dev!.id }, to: { kind: 'agent', id: 'b1', departmentId: dev!.id } });
      /* Another department's agents are not this one's. */
      stream.send({ type: 'pulse', from: { kind: 'agent', id: 'x0', departmentId: 'other' }, to: { kind: 'agent', id: 'x1', departmentId: 'other' } });
      const dots = [...document.querySelectorAll('.dview circle.pt animateMotion')];
      expect(dots.map(m => [m.getAttribute('path'), m.getAttribute('repeatCount')])).toEqual([[toD(stepPaths(schemaLayout(dev!, 1)).toMember('b1')!), '1']]);
      const duration = parseFloat(dots[0]!.getAttribute('dur')!) * 1000;
      act(() => { vi.advanceTimersByTime(duration / 2); });
      expect(dots[0]).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(duration / 2 + 20); });
      expect(document.querySelectorAll('.dview circle.pt, .dview .wires path.live')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows a Review owner handoff from frame to frame of the roles, marking who leads the stage, with no return to the author', async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    const dev = DEV_ORG.departments[0]!;
    const bruno = dev.employees.find(e => e.id === 'b1')!;
    const reviewer = { id: 'DEV-REV', title: { en: 'Code reviewer', ru: 'Ревьюер кода' }, description: { en: 'Reviews every change.', ru: 'Смотрит каждое изменение.' }, kind: 'member' as const, gate: 1 };
    const rita = { ...bruno, id: 'b2', name: 'Rita', roleId: 'DEV-REV' };
    const task = { id: 't1', number: 1, title: 'Checkout', echelons: taskRoute('development', bruno.id) };
    let moved = false;
    const before = { ...dev, roles: [...dev.roles, reviewer], employees: [...dev.employees.map(e => e.id === bruno.id ? { ...e, status: 'working' as const, task } : e), rita] };
    const after = { ...before, employees: before.employees.map(e => e.id === bruno.id ? { ...e, status: 'handed' as const, task: null } : e.id === rita.id ? { ...e, status: 'working' as const, task: { ...task, echelons: { ...taskRoute('review', rita.id), revision: 2 } } } : e) };
    shell({ 'GET /api/org': () => [200, { ...DEV_ORG, departments: [moved ? after : before] }] });
    await flyIn(user);
    const developers = () => screen.getByRole('group', { name: 'Backend engineer' });
    const reviewers = () => screen.getByRole('group', { name: 'Code reviewer' });
    expect(within(developers()).getByRole('button', { name: /Bruno/ })).toHaveClass('lead');
    expect(within(reviewers()).getByRole('button', { name: /Rita/ })).not.toHaveClass('lead');
    moved = true;
    stream.send({ type: 'task', id: task.id });
    await waitFor(() => expect(within(reviewers()).getByRole('button', { name: /Rita/ })).toHaveClass('lead'));
    expect(within(developers()).getByRole('button', { name: /Bruno/ })).not.toHaveClass('lead');
    expect(within(reviewers()).getByRole('button', { name: /Rita/ })).toHaveTextContent('Review #1 Checkout');
    expect(screen.queryByText(/work came back for rework/)).not.toBeInTheDocument();
    expect(document.querySelectorAll('.dview .rl, .dview .rah')).toHaveLength(0);
  });

  it('shows how hard each employee thinks next to its model', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const [dana, bruno] = dev!.employees;
    shell({}, { ...DEV_ORG, departments: [{ ...dev!, employees: [dana!, { ...bruno!, effort: 'max' }] }] });
    await flyIn(user);
    const members = screen.getByRole('region', { name: 'Members' });
    expect(within(members).getByRole('button', { name: /Bruno/ })).toHaveTextContent('Claude Sonnet 5.5, max effort, Anthropic');
  });

  it('says default effort for an employee whose level Hornhoof does not know', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const [dana, bruno] = dev!.employees;
    shell({}, { ...DEV_ORG, departments: [{ ...dev!, employees: [dana!, { ...bruno!, effort: null }] }] });
    await flyIn(user);
    const members = screen.getByRole('region', { name: 'Members' });
    expect(within(members).getByRole('button', { name: /Bruno/ })).toHaveTextContent('Claude Sonnet 5.5, default effort, Anthropic');
  });

  it('says how often an employee on a timer wakes, when it holds no task', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const [dana, bruno] = dev!.employees;
    shell({}, { ...DEV_ORG, departments: [{ ...dev!, employees: [dana!, { ...bruno!, timer: 10 }] }] });
    await flyIn(user);
    const members = screen.getByRole('region', { name: 'Members' });
    expect(within(members).getByRole('button', { name: /Bruno/ })).toHaveTextContent('On a timer, every 10 minutes');
  });

  it('refetches what employees do when their tasks move', async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    const [dev] = DEV_ORG.departments;
    const task = { id: 't12', number: 12, title: 'Checkout API', echelons: taskRoute() };
    const waits: Org = { ...DEV_ORG, departments: [{ ...dev!, employees: dev!.employees.map(e => (e.id === 'b1' ? { ...e, status: 'waiting' as const, task } : e)) }] };
    let asked = false;
    shell({ 'GET /api/org': () => [200, asked ? waits : DEV_ORG] });
    await flyIn(user);
    asked = true;
    stream.send({ type: 'requests' });
    await vi.waitFor(() => expect(within(screen.getByRole('region', { name: 'Members' })).getByRole('button', { name: /Bruno/ })).toHaveTextContent('needs a decision'));
  });

  it('wraps the words of the cards, the frames, the head and the people, and cuts or hides none of them', () => {
    const texts = ['.fn', '.fa', '.shead .hn', '.shead .meta', '.shead .hx', '.shead .hx-task', '.schip .r1', '.schip .mn', '.schip .st', '.schip .r2', '.schip .r3', '.pchip .pn b', '.pchip .pn span'];
    for (const selector of texts)
      for (const rule of rulesFor(selector)) {
        expect.soft(rule.decls['text-overflow'], `${selector} ends in no ellipsis`).not.toBe('ellipsis');
        expect.soft(rule.decls['-webkit-line-clamp'], `${selector} keeps every line`).toBeUndefined();
        expect.soft(rule.decls['white-space'], `${selector} wraps`).not.toBe('nowrap');
        expect.soft(rule.decls.overflow, `${selector} hides nothing`).not.toBe('hidden');
      }
    /* Words break between them, and only a word longer than the whole line breaks inside itself; a model's name may be its
       identifier, which breaks wherever it has to. */
    for (const selector of ['.fn', '.fa', '.shead .hn', '.shead .meta', '.shead .hx-task', '.schip .mn', '.schip .st', '.schip .r2', '.schip .r3', '.pchip .pn b', '.pchip .pn span'])
      expect.soft(decl(selector, 'overflow-wrap'), selector).toBe('break-word');
    /* The Head of Design's word for #1489 (#1539, N4): a word breaks by the syllables of the page's language, with a hyphen,
       on the schema and in the line of what happened, and a role's name is not letter-spaced right to left or in Arabic,
       Persian or Hebrew, where spacing tears joined letters apart. */
    for (const selector of ['.dcanvas', '.ticker']) {
      expect.soft(decl(selector, 'hyphens'), selector).toBe('auto');
      expect.soft(decl(selector, '-webkit-hyphens'), selector).toBe('auto');
    }
    for (const selector of ['[dir="rtl"] .role', '.role:lang(ar)', '.role:lang(fa)', '.role:lang(he)']) expect.soft(decl(selector, 'letter-spacing'), selector).toBe('0');
    /* A state of more words than the row has room for goes under the name, the name keeps a line of its own. */
    expect(decl('.schip .r1', 'flex-wrap')).toBe('wrap');
    expect(decl('.schip .r3 .ast', 'white-space')).toBe('normal');
    /* The cards stand at least their old size and keep their width: their slot is a grid of one column its card fills, a
       word longer than the card included. */
    for (const slot of ['.sslot', '.pchip', '.shead.empty']) {
      expect.soft(decl(slot, 'display'), slot).toBe('grid');
      expect.soft(decl(slot, 'grid-template-columns'), slot).toBe('minmax(0, 1fr)');
    }
  });

  it("wraps an agent's name and task in the speed drawer instead of cutting them", () => {
    for (const selector of ['.dv-drawer.spd .spl-r .who b', '.dv-drawer.spd .spl-r .who small']) {
      for (const rule of rulesFor(selector)) {
        expect.soft(rule.decls['text-overflow'], selector).not.toBe('ellipsis');
        expect.soft(rule.decls['white-space'], selector).not.toBe('nowrap');
        expect.soft(rule.decls.overflow, selector).not.toBe('hidden');
      }
      expect(decl(selector, 'overflow-wrap'), selector).toBe('break-word');
      expect(decl(selector, 'min-width'), selector).toBe('0');
    }
    expect(decl('.dv-drawer.spd .spl-r .who', 'flex-wrap')).toBe('wrap');
  });

  it('shows a long model name and a long task title whole on a card that grows with them, and moves the cards under it down', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const [dana, bruno] = dev!.employees;
    const model = 'Claude Sonnet 5.5 with the longest context window and extended thinking preview';
    const title = 'Move the checkout to the new payment_provider_and_keep_every_old_receipt_readable in both languages for years';
    const long = { ...bruno!, modelName: model, status: 'working' as const, task: { id: 't12', number: 12, title, echelons: taskRoute() } };
    const vera = { ...bruno!, id: 'b2', name: 'Vera' };
    /* jsdom lays nothing out: the card with the long words measures 150 px and the rest nothing, so they keep their size. */
    const tall = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('dept-chip') && this.textContent!.includes(title) ? 150 : 0;
    });
    onTestFinished(() => tall.mockRestore());
    shell({}, { ...DEV_ORG, departments: [{ ...dev!, employees: [dana!, long, vera] }] });
    await flyIn(user);
    const frame = within(screen.getByRole('region', { name: 'Department schema' })).getByRole('group', { name: 'Backend engineer' });
    const card = within(frame).getByRole('button', { name: /Bruno/ });
    expect(card.querySelector('.r2')).toHaveTextContent(`${model}, default effort, Anthropic`);
    expect(card.querySelector('.r3')).toHaveTextContent(`#12 ${title}`);
    const slot = (name: RegExp) => within(frame).getByRole('button', { name }).closest<HTMLElement>('.dept-chip')!;
    await waitFor(() => expect(parseFloat(slot(/Vera/).style.top) - parseFloat(slot(/Bruno/).style.top)).toBe(150 + 12));
    /* The head of Development's word for #1489: every chip of the department takes the height of the tallest one. */
    expect([slot(/Bruno/).style.height, slot(/Bruno/).style.minHeight]).toEqual(['', '150px']);
    expect([slot(/Vera/).style.height, slot(/Vera/).style.minHeight]).toEqual(['', '150px']);
    expect(parseFloat(frame.style.height)).toBe(100 + 2 * (150 + 12) + 8);
    /* The line from the frame's spine meets the card in its middle. */
    const spine = parseFloat(frame.style.left) + 10, middle = parseFloat(frame.style.top) + parseFloat(slot(/Bruno/).style.top) + 75;
    expect([...document.querySelectorAll('.dview .wires path.tick')].map(p => p.getAttribute('d'))).toContain(`M ${spine} ${middle} L ${spine + 10} ${middle}`);
  });

  it('moves the frames down under a head card that grows with its words, and stacks the people by their chips', async () => {
    const user = userEvent.setup();
    const tall = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.matches('.dview .sslot') && this.querySelector('.shead')) return 240;
      return this.matches('.dview .pchip') ? 90 : 0;
    });
    onTestFinished(() => tall.mockRestore());
    shell({}, { ...DEV_ORG, departments: [{ ...DEV_ORG.departments[0]!, people: [LENA, { ...LENA, id: 'p7', name: 'Mira' }] }] });
    await flyIn(user);
    const schema = screen.getByRole('region', { name: 'Department schema' });
    const head = schema.querySelector<HTMLElement>('.sslot:has(> .shead)')!;
    expect([head.style.height, head.style.minHeight]).toEqual(['', '184px']);
    const frame = within(schema).getByRole('group', { name: 'Backend engineer' });
    await waitFor(() => expect(frame.style.top).toBe(`${362 + 240 - 184}px`));
    const people = [...schema.querySelectorAll<HTMLElement>('.pchip')];
    expect(people.map(p => [p.style.top, p.style.height, p.style.minHeight])).toEqual([['12px', '', '56px'], [`${12 + 90 + 10}px`, '', '56px']]);
  });

  /* The Head of Design's word for #1489 (#1539): the head card keeps the room above the line of what the head does as the
     English words have it, so a card of more lines grows by them instead of taking that room. */
  it('keeps the room above what the head does fixed, as English has it, instead of what the card leaves over', () => {
    for (const rule of rulesFor('.shead .hx')) expect.soft(rule.decls['margin-top'], 'no room left over').toBeUndefined();
    expect(decl('.shead .hx', 'margin-block-start')).toBe('10px');
    expect(decl('.shead .edge-in', 'gap')).toBe('4px');
  });

  /* By the head of Development's word for #1489: far zoom shows colours on the chips and changes the size of nothing, so
     role names keep their size and no card or chip moves. */
  it('changes the size of no word in far zoom, so nothing moves', () => {
    for (const selector of ['.far .fn', '.far .fa', '.far .fc', '.far .schip .r2', '.far .schip .r3', '.far .schip .st'])
      for (const rule of rulesFor(selector)) {
        expect.soft(rule.decls['font-size'], selector).toBeUndefined();
        expect.soft(rule.decls.display, selector).toBeUndefined();
      }
    expect(decl('.far .fa', 'visibility')).toBe('hidden');
  });

  it("isolates each part of the head's and a chip's model line, so a right to left page keeps its order", async () => {
    const user = userEvent.setup();
    shell();
    await flyIn(user);
    const head = screen.getByRole('region', { name: 'Head' });
    const line = head.querySelector<HTMLElement>('.meta')!;
    expect(line.textContent!.split(', ').length).toBeGreaterThan(2);
    expect([...line.querySelectorAll('bdi')].map(b => b.textContent)).toEqual(line.textContent!.split(', '));
    const chip = within(screen.getByRole('region', { name: 'Members' })).getByRole('button', { name: /Bruno/ }).querySelector('.r2')!;
    expect([...chip.querySelectorAll('bdi')].map(b => b.textContent)).toEqual(chip.textContent!.split(', '));
  });

  /* The Head of Design's word for #1489 (#1539, N3): the department opens with its chips read at once, their names 11 px
     tall or more on the screen, on a phone too, and the canvas scrolls what does not fit; Show everything still shows all
     of it, far as that may be. N2: Show everything keeps the schema clear of the room kept at the bottom. */
  describe('where the schema stands', () => {
    const name = px(decl('.schip .mn', 'font-size'));
    const phone = { left: 0, width: 375, height: 812, bottom: 228 };

    it('opens a schema too wide for the screen at a size its chip names are read at, from its top left', () => {
      const view = schemaView(phone, { right: 1200, h: 700 }, false);
      expect(name * view.k).toBeGreaterThanOrEqual(11);
      expect(view).toEqual({ k: READABLE_K, x: 48 + 40 * READABLE_K, y: 76 + 20 * READABLE_K });
      /* Wide or narrow, a schema that does not fit opens as readable. */
      expect(name * schemaView({ left: 0, width: 1440, height: 900, bottom: 76 }, { right: 3000, h: 900 }, false).k).toBeGreaterThanOrEqual(11);
    });

    /* The Head of Design's word for #1554: on a phone a department opens on its head card, in the middle across, its top at
       the top of the room under the department's name, whatever room the bars leave at the top. */
    it('opens a schema too wide for a phone on its head card, centred, at the top of the room', () => {
      for (const free of [8, 116]) {
        const view = schemaView({ ...phone, free }, { right: 1200, h: 700, hx: 600 }, false, true);
        expect(view.k).toBe(READABLE_K);
        expect(view.x + 600 * view.k).toBe(375 / 2);
        expect(view.y).toBe(free);
      }
      /* A schema that fits, and Show everything, stand whole as before. */
      const fits = { right: 200, h: 200, hx: 100 };
      expect(schemaView(phone, fits, false, true)).toEqual(schemaView(phone, fits, false));
      expect(schemaView(phone, { right: 1200, h: 700, hx: 600 }, true, true)).toEqual(schemaView(phone, { right: 1200, h: 700 }, true));
    });

    it('opens a schema that fits whole, as Show everything shows it', () => {
      const room = { left: 0, width: 1440, height: 900, bottom: 76 };
      expect(schemaView(room, { right: 1220, h: 662 }, false)).toEqual(schemaView(room, { right: 1220, h: 662 }, true));
      expect(schemaView(room, { right: 1220, h: 662 }, false).k).toBe(1);
    });

    it('shows all of a schema with Show everything, far as that may be, above the room kept at the bottom', () => {
      const size = { right: 1200, h: 700 };
      const view = schemaView(phone, size, true);
      expect(view.k).toBeLessThan(READABLE_K);
      expect(view.x - 40 * view.k + (size.right + 80) * view.k).toBeLessThanOrEqual(phone.width);
      expect(view.y - 20 * view.k + (size.h + 40) * view.k).toBeLessThanOrEqual(phone.height - phone.bottom);
      const tall = schemaView({ ...phone, width: 1440 }, { right: 600, h: 1400 }, true);
      expect(tall.y - 20 * tall.k + 1440 * tall.k).toBeLessThanOrEqual(phone.height - phone.bottom);
    });
  });

  it("says what an employee waits for in a few words that fit next to its name, in both languages", async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const waits: Org = { ...DEV_ORG, departments: [{ ...dev!, employees: dev!.employees.map(e => (e.id === 'b1' ? { ...e, status: 'waiting' as const } : e)) }] };
    shell({}, waits);
    await flyIn(user);
    const bruno = within(screen.getByRole('region', { name: 'Members' })).getByRole('button', { name: /Bruno/ });
    expect(bruno.querySelector('.st')).toHaveTextContent(/^needs a decision$/);
    expect(bruno.querySelector('.st')).toHaveAttribute('title', 'needs a decision');
    expect(ru.dept.status.waiting).toBe('ждет решения');
  });

  it('keeps the department actions in the free strip after the zoom while a window or task is open', () => {
    /* Windows and tasks end above the strip at the bottom where the zoom and the actions sit, so the actions
       stay there, right after the zoom, at every width a window leaves beside them; on a phone the window covers all.
       A window stands at the right in either direction, so right to left the actions keep the end, away from it (#1658). */
    const strip = px(decl('.dv-acts', 'bottom')) + px(decl('.hbtn', 'height'));
    for (const panel of ['.orch', '.acard']) expect(px(decl(panel, 'bottom'))).toBeGreaterThan(strip);
    const afterZoom = decl('.dview .ticker', 'inset-inline')!.split(' ')[0];
    for (const kind of ['window', 'task']) {
      expect(rulesFor(`.body.with-${kind} .dv-acts:dir(ltr)`).map(r => [r.media, r.decls['inset-inline'], r.decls.bottom])).toEqual([
        ['(min-width: 761px)', `${afterZoom} auto`, undefined],
      ]);
      expect(rulesFor(`.body.with-${kind} .dv-acts`)).toEqual([]);
    }
  });

  it('keeps an idle reviewer in its role frame behind gate 1, with no return arrows', async () => {
    const user = userEvent.setup();
    const dev = DEV_ORG.departments[0]!;
    const rita = { ...dev.employees[1]!, id: 'b2', name: 'Rita', roleId: 'DEV-REV', title: { en: 'Code reviewer', ru: 'Ревьюер кода' } };
    const reviewer = { id: 'DEV-REV', title: rita.title, description: { en: 'Reviews every change.', ru: 'Смотрит каждое изменение.' }, kind: 'member' as const, gate: 1 };
    shell({}, { ...DEV_ORG, departments: [{ ...dev, employees: [...dev.employees, rita], roles: [...dev.roles, reviewer] }] });
    await flyIn(user);
    const schema = screen.getByRole('region', { name: 'Department schema' });
    const frame = within(schema).getByRole('group', { name: 'Code reviewer' });
    expect(within(frame).getByRole('button', { name: /Rita/ })).toBeInTheDocument();
    expect(frame).toHaveClass('gt');
    expect([...schema.querySelectorAll('.gl')].map(g => g.textContent)).toEqual(['Gate 1']);
    expect(schema.querySelectorAll('.rl, .rah')).toHaveLength(0);
    expect(screen.getByRole('region', { name: 'Head' })).toHaveTextContent('1 of 3 agents working, 2 roles');
  });

  it('hires through the orchestrator', async () => {
    const user = userEvent.setup();
    const calls = shell({ 'POST /api/agents/orchestrator/messages': [202, { jobId: 'j9' }] });
    await flyIn(user);
    await user.click(screen.getByRole('button', { name: '+ Hire' }));
    expect(await screen.findByRole('complementary', { name: 'Orchestrator' })).toBeInTheDocument();
    await vi.waitFor(() => expect(calls.find(c => c.path === '/api/agents/orchestrator/messages')?.body).toEqual({ text: 'Staff the Development department.' }));
    expect(calls.filter(c => c.path === '/api/agents/orchestrator/messages')).toHaveLength(1);
  });

  it('shows the hand-made roster when he cannot answer', async () => {
    const user = userEvent.setup();
    const calls = shell({
      [`GET ${EVENTS}`]: [200, { events: [], state: { ...READY, ready: false, reason: 'no_subscription' } }],
      'GET /api/departments/d2/roster': [200, ROSTER],
    });
    await flyIn(user);
    await user.click(screen.getByRole('button', { name: '+ Hire' }));
    expect(await screen.findByText('Hiring for Development')).toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: /Head of development/ })).toBeChecked();
    expect(await screen.findByRole('button', { name: 'Hire (2)' })).toBeEnabled();
    expect(screen.queryByText('Company structure')).not.toBeInTheDocument();
    expect(calls.some(c => c.path === '/api/agents/orchestrator/messages')).toBe(false);
  });

  it("opens an employee's window from the department, with its card one click away", async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/agents/b1': [200, CARD], 'GET /api/agents/b1/events?last=300': [200, { events: [], state: READY }] });
    await flyIn(user);
    await user.click(screen.getByRole('button', { name: /Bruno/ }));
    expect(await screen.findByRole('complementary', { name: 'Bruno, Backend engineer' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Card' }));
    expect(await screen.findByRole('complementary', { name: 'Card: Bruno' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Bruno, Backend engineer' })).toBeInTheDocument();
  });

  it("closes an employee's card back to its window, which stood there all along", async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/agents/b1': [200, CARD], 'GET /api/agents/b1/events?last=300': [200, { events: [], state: READY }] });
    await flyIn(user);
    await user.click(screen.getByRole('button', { name: /Bruno/ }));
    const window = await screen.findByRole('complementary', { name: 'Bruno, Backend engineer' });
    const toggle = within(window).getByRole('button', { name: 'Card' });
    await user.click(toggle);
    const card = await screen.findByRole('complementary', { name: 'Card: Bruno' });
    await user.click(within(card).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('complementary', { name: 'Card: Bruno' })).not.toBeInTheDocument();
    expect(window).toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });

  it("opens a head's department notebook from its window", async () => {
    const user = userEvent.setup();
    const DANA_CARD = { ...CARD, id: 'b0', name: 'Dana', kind: 'head' };
    const calls = shell({
      'GET /api/agents/b0': [200, DANA_CARD],
      'GET /api/agents/b0/events?last=300': [200, { events: [], state: READY }],
      'GET /api/departments/d2/notebook': [200, { notes: [{ number: 2, text: 'Review every merge.', by: { kind: 'agent', id: 'b0', name: 'Dana' }, updatedAt: '2026-10-31T02:00:00Z' }] }],
    });
    await flyIn(user);
    await user.click(document.querySelector<HTMLButtonElement>('button.shead')!);
    await user.click(await screen.findByRole('button', { name: 'Notebook' }));
    const list = await screen.findByRole('list', { name: 'Notebook' });
    expect(list).toHaveTextContent('#2Review every merge.Dana');
    expect(screen.getByText(/What the head of this department remembers/)).toBeInTheDocument();
    expect(calls.some(c => c.path === '/api/notebook')).toBe(false);
  });

  it('switches an employee off from its chip without opening it', async () => {
    const user = userEvent.setup();
    const calls = shell({ 'PATCH /api/agents/b1': [200, { ...CARD, on: false }] });
    await flyIn(user);
    const tick = screen.getByRole('checkbox', { name: 'Bruno is on' });
    expect(tick).toBeChecked();
    await user.click(tick);
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH' && c.path === '/api/agents/b1')?.body).toEqual({ on: false }));
    expect(tick).not.toBeChecked();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(screen.getByText('Bruno: switched off')).toBeInTheDocument();
  });

  it("switches a whole role off from its frame, so its people get no work", async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const boris = { ...dev!.employees[1]!, id: 'b2', name: 'Boris', on: false };
    const two: Org = { ...DEV_ORG, departments: [{ ...dev!, employees: [...dev!.employees, boris] }] };
    const calls = shell({ 'PATCH /api/agents/b1': [200, { ...CARD, on: false }] }, two);
    await flyIn(user);
    const role = screen.getByRole('checkbox', { name: 'Backend engineer takes part in the work' });
    expect(role).toBeChecked();
    await user.click(role);
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH' && c.path === '/api/agents/b1')?.body).toEqual({ on: false }));
    /* Boris was off already. */
    expect(calls.some(c => c.method === 'PATCH' && c.path === '/api/agents/b2')).toBe(false);
    expect(role).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Bruno is on' })).not.toBeChecked();
    expect(screen.getByText('Backend engineer: everyone switched off')).toBeInTheDocument();
  });

  it('switches every one of a role on from its frame', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const boris = { ...dev!.employees[1]!, id: 'b2', name: 'Boris', on: false };
    const off: Org = { ...DEV_ORG, departments: [{ ...dev!, employees: [dev!.employees[0]!, { ...dev!.employees[1]!, on: false }, boris] }] };
    const calls = shell({ 'PATCH /api/agents/b1': [200, CARD], 'PATCH /api/agents/b2': [200, CARD] }, off);
    await flyIn(user);
    const role = screen.getByRole('checkbox', { name: 'Backend engineer takes part in the work' });
    expect(role).not.toBeChecked();
    await user.click(role);
    await vi.waitFor(() => expect(calls.filter(c => c.method === 'PATCH').map(c => [c.path, c.body])).toEqual([
      ['/api/agents/b1', { on: true }],
      ['/api/agents/b2', { on: true }],
    ]));
    expect(role).toBeChecked();
    expect(await screen.findByText('Backend engineer: everyone on')).toBeInTheDocument();
  });

  it('shows an employee that is off as switched off', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const off: Org = { ...DEV_ORG, departments: [{ ...dev!, employees: dev!.employees.map(e => (e.id === 'b1' ? { ...e, on: false } : e)) }] };
    shell({}, off);
    await flyIn(user);
    expect(screen.getByRole('checkbox', { name: 'Bruno is on' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: /Bruno/ })).toHaveTextContent('Switched off');
  });

  it('marks the head and each employee with the program they work in', async () => {
    const user = userEvent.setup();
    shell({});
    await flyIn(user);
    expect(within(screen.getByRole('button', { name: /Bruno/ })).getByRole('img', { name: 'Claude' })).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /Dana/ })).getByRole('img', { name: 'Claude' })).toBeInTheDocument();
  });

  it('opens the tracker for the department from its Tasks button, and leaves the department behind', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/tasks?status=all': [200, { tasks: TASKS }], 'GET /api/turns': [200, { turns: [] }], 'GET /api/goals': [200, { goals: [] }], 'GET /api/pipelines': [200, { pipelines: [] }] });
    await flyIn(user);
    await drawer(user, 'Department tasks');
    expect(location.pathname + location.search).toBe('/tasks?department=d2');
    expect(await screen.findByRole('heading', { level: 1, name: 'Development / List' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'Development' })).not.toBeInTheDocument();
  });

  it('says nothing in its About of how the department works, as every department works in one flow of tasks', async () => {
    const user = userEvent.setup();
    const calls = shell({});
    await flyIn(user);
    await drawer(user, 'About the department');
    expect(await screen.findByRole('region', { name: 'Approvals' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'How it works' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Works in turns' })).toBeNull();
    expect(calls.some(c => c.path.endsWith('/work-mode'))).toBe(false);
  });

  it('lets the owner of the department hire into it, and change its repository and sub-units, without the orchestrator', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const calls = shell(
      { [DEV_TASKS]: [200, { tasks: [] }], 'GET /api/departments/d2/roster': [200, ROSTER] },
      { ...DEV_ORG, departments: [{ ...dev!, ownerPersonId: 'p6', people: [...dev!.people, LENA] }] },
      listed('p6', 'Lena'),
    );
    await flyIn(user);
    await drawer(user, 'About the department');
    const about = screen.getByRole('complementary', { name: 'About the department' });
    expect(within(about).getByRole('region', { name: 'Repositories' })).toBeInTheDocument();
    expect(within(about).getByRole('region', { name: 'Sub-units' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '+ Hire' }));
    expect(await screen.findByText('Hiring for Development')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Hire (2)' })).toBeEnabled();
    expect(screen.queryByRole('complementary', { name: 'Orchestrator' })).not.toBeInTheDocument();
    expect(calls.some(c => c.path === '/api/agents/orchestrator/messages')).toBe(false);
  });

  it('lets everyone given the department hire into it and change its repository and sub-units, with no owner named', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    shell(
      { [DEV_TASKS]: [200, { tasks: [] }], 'GET /api/departments/d2/roster': [200, ROSTER] },
      { ...DEV_ORG, departments: [{ ...dev!, ownerPersonId: null, people: [...dev!.people, LENA] }] },
      listed('p6', 'Lena'),
    );
    await flyIn(user);
    await drawer(user, 'About the department');
    const about = screen.getByRole('complementary', { name: 'About the department' });
    expect(within(about).getByRole('region', { name: 'Repositories' })).toBeInTheDocument();
    expect(within(about).getByRole('region', { name: 'Sub-units' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '+ Hire' }));
    expect(await screen.findByText('Hiring for Development')).toBeInTheDocument();
  });

  it("says in plain words that an employee's window is for the people of its department, and opens none", async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const org = { ...DEV_ORG, departments: [{ ...dev!, employees: dev!.employees.map(e => ({ ...e, opens: false })) }] };
    const calls = shell({ 'GET /api/agents/b1': [200, CARD], 'GET /api/agents/b1/events?last=300': [200, { events: [], state: READY }] }, org, listed('p7', 'Kira'));
    await flyIn(user);
    await user.click(screen.getByRole('button', { name: /Bruno/ }));
    expect(await screen.findAllByText('Bruno: everyone sees the work, and only the people of this department open the window.')).not.toHaveLength(0);
    expect(screen.queryByRole('complementary', { name: 'Bruno, Backend engineer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Insufficient permissions' })).not.toBeInTheDocument();
    expect(calls.some(c => c.path.startsWith('/api/agents/b1'))).toBe(false);
  });

  it('shows and changes the repository for people who see the whole company', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const calls = shell(
      { [DEV_TASKS]: [200, { tasks: [] }], 'PUT /api/departments/d2/repository': [200, { repository: { ...REPO, branch: 'develop' } }], 'DELETE /api/departments/d2/repository': [204] },
      { ...DEV_ORG, departments: [{ ...dev!, repository: REPO }] },
    );
    await flyIn(user);
    await drawer(user, 'About the department');
    const repo = screen.getByRole('region', { name: 'Repositories' });
    expect(repo).toHaveTextContent('https://github.com/acme/app.git');
    expect(repo).toHaveTextContent('Branch main');
    expect(repo).toHaveTextContent('Token ending in 1234');
    await user.click(within(repo).getByRole('button', { name: 'Change' }));
    expect(within(repo).getByLabelText('Address')).toHaveValue('https://github.com/acme/app.git');
    expect(within(repo).getByLabelText('Token')).toHaveAttribute('type', 'text');
    expect(within(repo).getByLabelText('Token')).toHaveClass('secret-masked');
    expect(within(repo).getByLabelText('Token')).toHaveValue('');
    const branch = within(repo).getByLabelText('Branch');
    await user.clear(branch);
    await user.type(branch, 'develop');
    await user.click(within(repo).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ url: 'https://github.com/acme/app.git', branch: 'develop' }));
    expect(within(repo).queryByLabelText('Branch')).not.toBeInTheDocument();
    await user.click(within(repo).getByRole('button', { name: 'Remove' }));
    await user.click(within(repo).getByRole('button', { name: 'Yes, remove' }));
    await vi.waitFor(() => expect(calls.some(c => c.method === 'DELETE' && c.path === '/api/departments/d2/repository')).toBe(true));
  });

  it('says how much free memory a test run of the repository needs, and changes it', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const calls = shell(
      { [DEV_TASKS]: [200, { tasks: [] }], 'PUT /api/departments/d2/repository': [200, { repository: { ...REPO, testMemoryGb: 8 } }] },
      { ...DEV_ORG, departments: [{ ...dev!, repository: { ...REPO, testMemoryGb: 4 } }] },
    );
    await flyIn(user);
    await drawer(user, 'About the department');
    const repo = screen.getByRole('region', { name: 'Repositories' });
    expect(repo).toHaveTextContent('A test run needs a machine with 4 GB of free memory');
    await user.click(within(repo).getByRole('button', { name: 'Change' }));
    const memory = within(repo).getByLabelText('Free memory for a test run, GB');
    expect(memory).toHaveValue(4);
    await user.clear(memory);
    await user.type(memory, '8');
    await user.click(within(repo).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ url: 'https://github.com/acme/app.git', branch: 'main', testMemoryGb: 8 }));
  });

  it("suggests a commit author's name in the person's language", async () => {
    const user = userEvent.setup();
    localStorage.setItem('hh-lang', 'ru');
    try {
      render(
        <LanguageProvider>
          <RepoSettings placeId="d2" repository={null} />
        </LanguageProvider>,
      );
      await user.click(screen.getByRole('button', { name: 'Подключить репозиторий' }));
      expect(screen.getByLabelText('Автор коммитов')).toHaveAttribute('placeholder', 'Анна Смирнова');
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });

  it("names who the agents' commits are by once both fields are filled", async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const author = { name: 'Alex Rivera', email: 'alex@acme.example' };
    const calls = shell(
      { [DEV_TASKS]: [200, { tasks: [] }], 'PUT /api/departments/d2/repository': [200, { repository: { ...REPO, author } }] },
      { ...DEV_ORG, departments: [{ ...dev!, repository: REPO }] },
    );
    await flyIn(user);
    await drawer(user, 'About the department');
    const repo = screen.getByRole('region', { name: 'Repositories' });
    expect(repo).not.toHaveTextContent('Commits as');
    await user.click(within(repo).getByRole('button', { name: 'Change' }));
    await user.type(within(repo).getByLabelText('Commit author'), 'Alex Rivera');
    expect(within(repo).getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(within(repo).getByLabelText('Author email'), 'alex@acme.example');
    await user.click(within(repo).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ url: 'https://github.com/acme/app.git', branch: 'main', author }));
  });

  it("shows who the agents' commits are by, and takes the name away when both fields are empty", async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const calls = shell(
      { [DEV_TASKS]: [200, { tasks: [] }], 'PUT /api/departments/d2/repository': [200, { repository: { ...REPO, author: null } }] },
      { ...DEV_ORG, departments: [{ ...dev!, repository: { ...REPO, author: { name: 'Alex Rivera', email: 'alex@acme.example' } } }] },
    );
    await flyIn(user);
    await drawer(user, 'About the department');
    const repo = screen.getByRole('region', { name: 'Repositories' });
    expect(repo).toHaveTextContent('Commits as Alex Rivera <alex@acme.example>');
    await user.click(within(repo).getByRole('button', { name: 'Change' }));
    expect(within(repo).getByLabelText('Commit author')).toHaveValue('Alex Rivera');
    await user.clear(within(repo).getByLabelText('Commit author'));
    await user.clear(within(repo).getByLabelText('Author email'));
    await user.click(within(repo).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ url: 'https://github.com/acme/app.git', branch: 'main', author: null }));
  });

  it("gives a product its own repository with a token", async () => {
    const user = userEvent.setup();
    const calls = shell({ [DEV_TASKS]: [200, { tasks: [] }], 'PUT /api/departments/pd1/repository': [200, { repository: REPO }] });
    await flyIn(user);
    await drawer(user, 'About the department');
    const repos = screen.getByRole('region', { name: 'Repositories' });
    const own = within(repos).getByRole('listitem', { name: "The department's own" });
    expect(own).toHaveTextContent('No repository of its own yet. A task that names no product works in an empty folder.');
    const mascot = within(repos).getByRole('listitem', { name: 'Mascot' });
    await user.click(within(mascot).getByRole('button', { name: 'Connect repository' }));
    await user.type(within(mascot).getByLabelText('Address'), 'https://github.com/acme/mascot.git');
    await user.type(within(mascot).getByLabelText('Token'), 'ghp_mascot5678');
    await user.click(within(mascot).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() =>
      expect(calls.find(c => c.method === 'PUT')).toEqual({ method: 'PUT', path: '/api/departments/pd1/repository', body: { url: 'https://github.com/acme/mascot.git', branch: 'main', token: 'ghp_mascot5678' } }),
    );
    /* The products list keeps their briefings; their repositories are under Repositories. */
    expect(within(screen.getByRole('region', { name: 'Products' })).queryByRole('button', { name: 'Connect repository' })).not.toBeInTheDocument();
  });

  it("lists the department's own repository first, then each product's", async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const mobile = { url: 'https://github.com/acme/mobile.git', branch: 'release', tokenLast4: null };
    shell(
      { [DEV_TASKS]: [200, { tasks: [] }] },
      { ...DEV_ORG, departments: [{ ...dev!, repository: REPO, products: [{ id: 'pd1', name: 'Mascot', repository: null }, { id: 'pd2', name: 'Mobile', repository: mobile }] }] },
    );
    await flyIn(user);
    await drawer(user, 'About the department');
    const repos = screen.getByRole('region', { name: 'Repositories' });
    expect(within(repos).getAllByRole('listitem').map(li => li.querySelector('b')?.textContent)).toEqual(["The department's own", 'Mascot', 'Mobile']);
    expect(within(repos).getByRole('listitem', { name: "The department's own" })).toHaveTextContent('https://github.com/acme/app.git');
    const line = within(repos).getByRole('listitem', { name: 'Mobile' });
    expect(line).toHaveTextContent('https://github.com/acme/mobile.git');
    expect(line).toHaveTextContent('Branch release');
    expect(line).toHaveTextContent('No token, for a public repository');
    expect(within(within(repos).getByRole('listitem', { name: 'Mascot' })).getByRole('button', { name: 'Connect repository' })).toBeInTheDocument();
  });

  it('adds another repository as a product named after its address, unless another name is typed', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const made = { product: { id: 'pd2', name: 'mobile-app', repository: { url: 'https://github.com/acme/mobile-app.git', branch: 'main', tokenLast4: '9999' } } };
    const calls = shell({ [DEV_TASKS]: [200, { tasks: [] }], 'POST /api/departments/d2/repositories': [201, made] }, { ...DEV_ORG, departments: [{ ...dev!, repository: REPO }] });
    await flyIn(user);
    await drawer(user, 'About the department');
    const repos = screen.getByRole('region', { name: 'Repositories' });
    await user.click(within(repos).getByRole('button', { name: 'Add repository' }));
    const form = within(repos).getByRole('form', { name: 'Add repository' });
    await user.type(within(form).getByLabelText('Address'), 'https://github.com/acme/mobile-app.git');
    expect(within(form).getByLabelText('Name')).toHaveValue('mobile-app');
    await user.type(within(form).getByLabelText('Token'), 'ghp_mobile9999');
    expect(within(form).getByLabelText('Token')).toHaveAttribute('type', 'text');
    expect(within(form).getByLabelText('Token')).toHaveClass('secret-masked');
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    await vi.waitFor(() =>
      expect(calls.find(c => c.method === 'POST' && c.path === '/api/departments/d2/repositories')?.body).toEqual({ name: 'mobile-app', url: 'https://github.com/acme/mobile-app.git', branch: 'main', token: 'ghp_mobile9999' }),
    );
    expect(within(repos).queryByRole('form', { name: 'Add repository' })).not.toBeInTheDocument();

    await user.click(within(repos).getByRole('button', { name: 'Add repository' }));
    const again = within(repos).getByRole('form', { name: 'Add repository' });
    await user.type(within(again).getByLabelText('Name'), 'Server');
    await user.type(within(again).getByLabelText('Address'), 'https://github.com/acme/api.git');
    expect(within(again).getByLabelText('Name')).toHaveValue('Server');
    await user.type(within(again).getByLabelText('Commit author'), 'Alex Rivera');
    expect(within(again).getByRole('button', { name: 'Add' })).toBeDisabled();
    await user.type(within(again).getByLabelText('Author email'), 'alex@acme.example');
    await user.click(within(again).getByRole('button', { name: 'Add' }));
    await vi.waitFor(() =>
      expect(calls.filter(c => c.method === 'POST' && c.path === '/api/departments/d2/repositories').map(c => c.body)[1]).toEqual({ name: 'Server', url: 'https://github.com/acme/api.git', branch: 'main', author: { name: 'Alex Rivera', email: 'alex@acme.example' } }),
    );
  });

  it('says why another repository was refused, and keeps what was typed', async () => {
    const user = userEvent.setup();
    const refused = { error: { code: 'conflict', message: 'The department Development keeps https://github.com/acme/app.git.', reason: 'repo_folder_taken' } };
    shell({ [DEV_TASKS]: [200, { tasks: [] }], 'POST /api/departments/d2/repositories': [409, refused] });
    await flyIn(user);
    await drawer(user, 'About the department');
    const repos = screen.getByRole('region', { name: 'Repositories' });
    await user.click(within(repos).getByRole('button', { name: 'Add repository' }));
    const form = within(repos).getByRole('form', { name: 'Add repository' });
    await user.type(within(form).getByLabelText('Address'), 'https://github.com/other/app.git');
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Another repository of this department has an address that ends in the same name.');
    expect(within(form).getByLabelText('Address')).toHaveValue('https://github.com/other/app.git');
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(within(repos).queryByRole('form', { name: 'Add repository' })).not.toBeInTheDocument();
  });

  it('lists a sub-unit employee under the sub-unit name instead of its role group, and creates, renames, moves and deletes a sub-unit from the screen', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const [dana, bruno] = dev!.employees;
    const sam = { ...bruno!, id: 'b2', name: 'Sam', teamId: 'u1' };
    const urgent = { id: 'u1', name: 'Urgent fixes', about: '', stage: 0, gate: false, turnkey: false };
    let org: Org = { ...DEV_ORG, departments: [{ ...dev!, teams: [urgent], employees: [dana!, bruno!, sam] }] };
    const calls = shell(
      {
        'GET /api/org': () => [200, org],
        'POST /api/departments/d2/teams': [201, { team: { id: 'u2', name: 'Hotfixes', about: '', stage: 0, gate: false, turnkey: false } }],
        'PATCH /api/departments/d2/teams/u1': [200, { team: { ...urgent, name: 'Fast lane' } }],
        'PATCH /api/agents/b1': [200, { ...CARD, team: { id: 'u1', name: 'Urgent fixes' } }],
        'DELETE /api/departments/d2/teams/u1': [204],
      },
      org,
    );
    await flyIn(user);
    const schema = screen.getByRole('region', { name: 'Department schema' });
    expect(within(schema).getByText('Urgent fixes')).toBeInTheDocument();
    await drawer(user, 'About the department');
    const about = screen.getByRole('complementary', { name: 'About the department' });
    const employees = within(about).getByRole('region', { name: 'Members' });
    const groups = [...employees.querySelectorAll('.dv-emp-g')].map(g => [
      g.querySelector('h4')!.textContent,
      [...g.querySelectorAll('li b')].map(b => b.textContent),
    ]);
    expect(groups).toEqual([
      ['Urgent fixes', ['Sam']],
      ['Backend engineer', ['Bruno']],
    ]);

    const subUnits = within(about).getByRole('region', { name: 'Sub-units' });
    await user.selectOptions(within(employees).getByLabelText('Sub-unit for Bruno'), 'u1');
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH' && c.path === '/api/agents/b1')?.body).toEqual({ team: 'u1' }));

    await user.click(within(subUnits).getByRole('button', { name: 'Rename' }));
    const renameBox = within(subUnits).getByLabelText('Sub-unit name');
    await user.clear(renameBox);
    await user.type(renameBox, 'Fast lane');
    await user.click(within(subUnits).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH' && c.path === '/api/departments/d2/teams/u1')?.body).toEqual({ name: 'Fast lane' }));

    await user.click(within(subUnits).getByRole('button', { name: 'New sub-unit' }));
    await user.type(within(subUnits).getByLabelText('Sub-unit name'), 'Hotfixes');
    await user.click(within(subUnits).getByRole('button', { name: 'Add sub-unit' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'POST' && c.path === '/api/departments/d2/teams')?.body).toEqual({ name: 'Hotfixes' }));

    await user.click(within(subUnits).getByRole('button', { name: 'Delete sub-unit' }));
    await vi.waitFor(() => expect(calls.some(c => c.method === 'DELETE' && c.path === '/api/departments/d2/teams/u1')).toBe(true));
  });
});

const TREE_PATH = '/api/departments/d2/tree';
function treeRoute(tree = DEV_TREE): Record<string, [number, unknown]> {
  const agents = TREE_ORG.departments.flatMap(d => d.employees.flatMap(e => [
    [`GET /api/agents/${e.id}`, [200, { ...CARD, id: e.id, name: e.name, kind: e.kind, state: e.state, role: { ...CARD.role!, title: e.title } }]],
    [`GET /api/agents/${e.id}/events?last=300`, [200, { events: [], state: READY }]],
  ]));
  return { ...Object.fromEntries(agents), [`GET ${TREE_PATH}`]: [200, { tree }] };
}

async function showTree(user: ReturnType<typeof userEvent.setup>) {
  await flyIn(user);
  await user.click(screen.getByRole('button', { name: 'Tree' }));
  return screen.findByRole('group', { name: 'Tree of turn 3' });
}

describe('Department work tree', () => {
  it('opens the current checker window from a task workflow card', async () => {
    const user = userEvent.setup();
    shell(treeRoute(REVIEW_TREE), TREE_ORG);
    const graph = await showTree(user);
    await user.click(graph.querySelector('[data-row="b6"]')!);
    const summary = screen.getByRole('dialog');
    expect(summary).toHaveTextContent('#54 Check card payment receipts');
    expect(within(summary).getByRole('list', { name: 'Task workflow' }).querySelector('[aria-current="step"]')).toHaveTextContent('Review');
    await user.click(within(summary).getByRole('button', { name: /Vera/ }));
    expect(await screen.findByRole('complementary', { name: 'Vera, Backend engineer' })).toBeInTheDocument();
  });

  it('shows the call places for the task opened in the department tree', async () => {
    const user = userEvent.setup();
    const tree = { ...REVIEW_TREE, lines: REVIEW_TREE.lines.map(line => line.number === 54 ? {
      ...line, echelons: { ...line.echelons, oneShot: { review: { fanOut: 2, judge: 'Read the answers' } } },
    } : line) };
    const call = { id: 'c1', number: 1, judge: false, by: 'b6', task: 54, stage: 'review', startedAt: null };
    const org = { ...TREE_ORG, departments: TREE_ORG.departments.map(d => ({ ...d, calls: [call] })) };
    shell(treeRoute(tree), org);
    const graph = await showTree(user);
    await user.click(graph.querySelector('[data-row="b6"]')!);
    const summary = screen.getByRole('dialog');
    const marks = within(summary).getAllByRole('img', { name: /^One-shot call: starts from zero each time, no memory/ });
    expect(marks).toHaveLength(3);
    expect(marks[0]).toHaveAccessibleName(/Call 1.*Waiting/);
    expect(marks[1]).toHaveAccessibleName(/Call 2.*Idle/);
    expect(marks[2]).toHaveAccessibleName(/Judge call.*Idle/);
  });

  it.each([
    ['name', false], ['task row', false], ['name', true], ['task row', true],
  ] as const)('opens the same window from the %s for busy=%s and can message the agent', async (source, busy) => {
    const user = userEvent.setup();
    const org = { ...TREE_ORG, departments: TREE_ORG.departments.map(d => ({ ...d, employees: d.employees.map(e => e.id === 'b1' ? {
      ...e, state: busy ? 'working' as const : 'sleeping' as const, status: busy ? 'working' as const : 'idle' as const,
    } : e) })) };
    const calls = shell({ ...treeRoute(),
      'GET /api/agents/b1': [200, CARD],
      'GET /api/agents/b1/events?last=300': [200, { events: [], state: { ...READY, busy, runningJobId: busy ? 'j1' : null } }],
      'POST /api/agents/b1/messages': [200, { queued: true }],
    }, org);
    const graph = await showTree(user);
    const target = source === 'name'
      ? within(document.querySelector('.tv-labs') as HTMLElement).getByRole('button', { name: /Bruno/ })
      : within(graph).getAllByRole('button', { name: /Bruno, #42 Payment gateway on the server/ })[0]!;
    await user.click(target);
    const card = await screen.findByRole('dialog');
    await user.click(within(card).getByRole('button', { name: /Bruno/ }));
    const window = await screen.findByRole('complementary', { name: 'Bruno, Backend engineer' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.type(within(window).getByRole('textbox', { name: 'Write to Bruno' }), 'Please check the cart{Enter}');
    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', path: '/api/agents/b1/messages', body: { text: 'Please check the cart' } }));
  });

  it.each([null, DEV_TREE.now])('keeps an unlinked head turn ending at %s and opens the head window', async end => {
    const user = userEvent.setup();
    const activity: NonNullable<DepartmentTree['activity']> = [{ jobId: 'head-talk', agent: { id: 'b0', name: 'Dana' }, task: null, segments: [{ kind: 'lost' as const,
      from: DEV_TREE.turn!.startedAt, to: end, program: { state: 'idle' as const, since: Date.parse(DEV_TREE.turn!.startedAt), tool: null } }] }];
    activity.push({ jobId: 'head-queue', agent: { id: 'b0', name: 'Dana' }, task: { id: 'r90', number: 90, title: 'Review' }, segments: [{ kind: 'queued', from: DEV_TREE.turn!.startedAt, to: end, waitsForAgent: { id: 'b0', name: 'Dana' } }] });
    shell(treeRoute({ ...DEV_TREE, activity }), TREE_ORG);
    const graph = await showTree(user);
    expect(within(document.querySelector('.tv-labs') as HTMLElement).getByRole('button', { name: /Dana/ })).toHaveTextContent('Default, default effort, Claude');
    expect([...graph.querySelectorAll('path.seg')].at(-1)).toHaveClass('ls');
    await user.click(within(graph).getByRole('button', { name: /Dana: turn end lost since/ }));
    const card = await screen.findByRole('dialog');
    expect(card).toHaveTextContent('No task');
    await user.click(within(card).getByRole('button', { name: /Dana/ }));
    expect(await screen.findByRole('complementary', { name: 'Dana, Head of development' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not hide a newer running task behind an older task external wait', async () => {
    const user = userEvent.setup();
    const externalWait = { reason: 'Image build', since: '2026-10-30T14:00:00.000Z', until: '2026-10-30T14:50:00.000Z' };
    const paused = { ...DEV_TREE.lines[0]!, live: false, mergedAt: null, doneAt: null, externalWait,
      segments: [{ kind: 'after' as const, from: externalWait.since, to: null, externalWait }] };
    const running = { ...paused, taskId: 'new-work', number: 99, title: 'New checkout work', externalWait: null, live: true,
      createdAt: DEV_TREE.now, segments: [{ kind: 'work' as const, from: DEV_TREE.now, to: null }] };
    shell(treeRoute({ ...DEV_TREE, lines: [paused, running] }), TREE_ORG);
    await showTree(user);
    const label = within(document.querySelector('.tv-labs') as HTMLElement).getByRole('button', { name: /Bruno/ });
    await user.click(label);
    const card = await screen.findByRole('dialog');
    expect(card).toHaveTextContent('#99');
    expect(card).not.toHaveTextContent('Image build');
  });

  it.each([375, 1440])('shows an external event reason and deadline as a calm wait at %ipx', async width => {
    vi.stubGlobal('innerWidth', width);
    onTestFinished(() => { vi.unstubAllGlobals(); });
    const user = userEvent.setup();
    const externalWait = { reason: 'Image build', since: '2026-10-30T14:00:00.000Z', until: '2026-10-30T14:50:00.000Z' };
    const line = { ...DEV_TREE.lines[0]!, mergedAt: null, doneAt: null, externalWait, waitsFor: [],
      segments: [{ kind: 'after' as const, from: externalWait.since, to: null, externalWait }] };
    shell(treeRoute({ ...DEV_TREE, lines: [line] }), TREE_ORG);
    const graph = await showTree(user);
    const label = within(document.querySelector('.tv-labs') as HTMLElement).getByRole('button', { name: /Bruno/ });
    await user.click(label);
    const card = await screen.findByRole('dialog');
    expect(card).toHaveTextContent('waits: Image build, until 14:50');
    expect(card.querySelector('.ast')).not.toHaveClass('alarm');
    expect(within(graph).getAllByRole('button', { name: /waits: Image build, until 14:50/ }).length).toBeGreaterThan(0);
  });

  it.each([
    { kind: 'lost', program: { state: 'idle', since: Date.parse(DEV_TREE.turn!.startedAt), tool: null }, text: 'turn end lost since 09:00: waiting for input', red: true },
    { kind: 'alarm', alarm: { reason: 'program_stalled', since: Date.parse(DEV_TREE.turn!.startedAt) }, text: 'program frozen since 09:00', red: true },
    { kind: 'queued', waitsForAgent: { id: 'b0', name: 'Dana' }, text: 'waits for Dana since 09:00', red: false },
    { kind: 'unknown', text: 'no data', red: false },
  ] as const)('keeps $kind and its cause and time on the read-only timeline', async state => {
    const user = userEvent.setup();
    const segment = { ...state, from: DEV_TREE.turn!.startedAt, to: null };
    const line = { ...DEV_TREE.lines[0]!, mergedAt: null, doneAt: null, createdAt: segment.from, cutAt: segment.from, segments: [segment] };
    shell(treeRoute({ ...DEV_TREE, lines: [line] }), TREE_ORG);
    const graph = await showTree(user);
    expect(within(graph).getAllByRole('button', { name: new RegExp(state.text) }).length).toBeGreaterThan(0);
    expect(graph.querySelector('.seg')).toHaveClass({ lost: 'ls', alarm: 'al', queued: 'q', unknown: 'u' }[state.kind]!);
  });

  it('shows interrupted time, queued message time and missing data separately in Speed', async () => {
    const user = userEvent.setup();
    const tree = { ...DEV_TREE, time: [{ agent: DEV_TREE.lines[0]!.agent, work: 2400, after: 0, person: 0, stall: 0, lost: 15749, alarm: 0, queued: 29950, unknown: 60 }] };
    shell(treeRoute(tree), TREE_ORG);
    await flyIn(user);
    await user.click(screen.getByRole('button', { name: 'Speed' }));
    const speed = screen.getByRole('complementary', { name: 'Speed' });
    await within(speed).findByText('Interrupted', { exact: true });
    expect(within(speed).getByText('Queued', { selector: '.sum dt' })).toBeInTheDocument();
    expect(within(speed).getByText('No data', { selector: '.sum dt' })).toBeInTheDocument();
    expect(speed.querySelector('.sum')).toHaveTextContent('4 h 22 min');
    expect(speed.querySelector('.sum')).toHaveTextContent('8 h 19 min');
  });

  it.each(['develop', undefined])('names the trunk and its card for repository branch %s', async branch => {
    const user = userEvent.setup();
    const departments = TREE_ORG.departments.map(d => ({
      ...d,
      repository: branch ? { ...REPO, branch } : undefined,
    }));
    shell(treeRoute(), { ...TREE_ORG, departments });
    const graph = await showTree(user);
    const name = branch ?? 'main';
    const labels = document.querySelector('.tv-labs') as HTMLElement;
    expect(within(labels).getByRole('button', { name })).toHaveClass('lchip');
    await user.click(within(graph).getByRole('button', { name }));
    const card = screen.getByRole('dialog', { name });
    expect(within(card).getByRole('heading', { level: 4, name })).toBeInTheDocument();
  });

  it('closes a branch card before Speed on separate Escapes', async () => {
    const user = userEvent.setup();
    shell(treeRoute(), TREE_ORG);
    const graph = await showTree(user);
    await user.click(screen.getByRole('button', { name: 'Speed' }));
    const speed = screen.getByRole('complementary', { name: 'Speed' });
    await user.click(within(graph).getByRole('button', { name: 'main' }));
    expect(screen.getByRole('dialog', { name: 'main' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(speed).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(speed).not.toBeInTheDocument();
  });

  it('places named square icons first, swaps the schema, and keeps focus on Map', async () => {
    const user = userEvent.setup();
    const calls = shell(treeRoute(), TREE_ORG);
    await flyIn(user);
    const tree = screen.getByRole('button', { name: 'Tree' });
    const speed = screen.getByRole('button', { name: 'Speed' });
    expect([...tree.parentElement!.children].slice(0, 3)).toEqual([tree, speed, screen.getByRole('button', { name: 'Department tasks' })]);
    for (const button of [tree, speed]) {
      expect(button).toHaveClass('hbtn', 'glass', 'ib');
      expect(button).toHaveAttribute('title', button.getAttribute('aria-label'));
      expect(button).toHaveTextContent('');
    }
    expect(tree).not.toHaveAttribute('aria-pressed');
    await user.click(tree);
    await screen.findByRole('group', { name: 'Tree of turn 3' });
    expect(screen.queryByRole('region', { name: 'Department schema' })).not.toBeInTheDocument();
    expect(within(document.querySelector('.dview') as HTMLElement).getByRole('button', { name: 'Map' })).toHaveFocus();
    expect(calls.filter(c => c.path === TREE_PATH)).toHaveLength(1);
    await user.click(tree);
    expect(screen.getByRole('region', { name: 'Department schema' })).toBeInTheDocument();
  });

  it('closes Speed with X, its button and Escape, keeping its open appearance', async () => {
    const user = userEvent.setup();
    shell(treeRoute());
    await flyIn(user);
    const speed = screen.getByRole('button', { name: 'Speed' });
    for (const close of ['x', 'button', 'escape']) {
      await user.click(speed);
      const panel = screen.getByRole('complementary', { name: 'Speed' });
      expect(panel).toHaveClass('dv-drawer', 'spd');
      expect(panel).not.toHaveClass('right');
      expect(within(panel).getByText('Speed', { selector: 'b' })).toBeInTheDocument();
      expect(speed).toHaveClass('on');
      expect(speed).toHaveAttribute('aria-expanded', 'true');
      if (close === 'x') await user.click(within(panel).getByRole('button', { name: 'Close' }));
      if (close === 'button') await user.click(speed);
      if (close === 'escape') await user.keyboard('{Escape}');
      expect(screen.queryByRole('complementary', { name: 'Speed' })).not.toBeInTheDocument();
      expect(speed).toHaveAttribute('aria-expanded', 'false');
    }
  });

  it('keeps Speed on the left while the agent window is open', async () => {
    const user = userEvent.setup();
    shell({ ...treeRoute(), 'GET /api/agents/b1/card': [200, CARD] });
    await flyIn(user);
    await user.click(within(screen.getByRole('region', { name: 'Members' })).getByRole('button', { name: /Bruno/ }));
    await user.click(screen.getByRole('button', { name: 'Speed' }));
    expect(screen.getByRole('complementary', { name: 'Speed' })).not.toHaveClass('right');
  });

  it.each(['tab', 'back'])('resets the tree and drawer when leaving through %s', async way => {
    const user = userEvent.setup();
    shell({ ...treeRoute(), 'GET /api/tasks?status=open': [200, { tasks: [] }], 'GET /api/turns': [200, { turns: [] }] });
    await showTree(user);
    await user.click(screen.getByRole('button', { name: 'Speed' }));
    if (way === 'back') await user.click(screen.getByRole('button', { name: 'Back to the map' }));
    else {
      await user.click(screen.getByRole('button', { name: 'Tasks' }));
      await user.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Map' }));
    }
    if (!screen.queryByRole('heading', { level: 2, name: 'Development' })) await flyIn(user);
    expect(screen.getByRole('region', { name: 'Department schema' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Speed' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tree' })).toBeInTheDocument();
  });

  it('keeps the same window and draft when another task of its agent is selected', async () => {
    const user = userEvent.setup();
    shell(treeRoute(), TREE_ORG);
    const graph = await showTree(user);
    await user.click(graph.querySelector('[data-row="b1"]')!);
    const card = await screen.findByRole('dialog');
    await user.click(within(card).getByRole('button', { name: /Bruno/ }));
    const window = await screen.findByRole('complementary', { name: 'Bruno, Backend engineer' });
    await user.type(within(window).getByRole('textbox'), 'Draft');
    await user.click(within(document.querySelector('.tv-labs') as HTMLElement).getByRole('button', { name: /Bruno/ }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /Bruno/ }));
    expect(screen.getByRole('complementary', { name: 'Bruno, Backend engineer' })).toBe(window);
    expect(within(window).getByRole('textbox')).toHaveValue('Draft');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows whole-turn totals, opens the agent window from Speed and lists open idle stretches first', async () => {
    const user = userEvent.setup();
    shell(treeRoute(), TREE_ORG);
    await flyIn(user);
    await user.click(screen.getByRole('button', { name: 'Speed' }));
    const speed = screen.getByRole('complementary', { name: 'Speed' });
    await within(speed).findByRole('button', { name: /Bruno/ });
    expect(speed.querySelectorAll('.sum dd')).toHaveLength(6);
    await user.click(within(speed).getByRole('button', { name: /Bruno/ }));
    expect(await screen.findByRole('complementary', { name: 'Bruno, Backend engineer' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Department schema' })).toBeInTheDocument();
    await user.click(within(speed).getByRole('tab', { name: 'Idle' }));
    const idle = [...speed.querySelectorAll('.idle')];
    expect(idle.slice(0, 3).every(e => e.textContent!.includes('still going'))).toBe(true);
    expect(idle[3]).toHaveTextContent('Timur');
  });

  it('runs a dot with motion enabled and uses the map zoom step', async () => {
    const user = userEvent.setup();
    shell(treeRoute(), TREE_ORG);
    await showTree(user);
    expect(document.querySelector('.tview animateMotion')).toBeInTheDocument();
    const scale = document.querySelector('.dview .zoom .zv')!;
    expect(scale).toHaveTextContent('100%');
    await user.click(within(document.querySelector('.dview') as HTMLElement).getByRole('button', { name: 'Zoom in' }));
    expect(scale).toHaveTextContent('120%');
    await user.click(within(document.querySelector('.dview') as HTMLElement).getByRole('button', { name: 'Show everything' }));
    expect(parseInt(scale.textContent!)).toBeLessThan(100);
  });

  it('keeps the same tree dot when reduced motion slows it down', async () => {
    let reduce = false;
    const changes = new Set<() => void>();
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() { return reduce && query.includes('reduced-motion'); },
      addEventListener(_event: string, update: () => void) { changes.add(update); },
      removeEventListener(_event: string, update: () => void) { changes.delete(update); },
    }));
    const user = userEvent.setup();
    shell(treeRoute(), TREE_ORG);
    await showTree(user);
    const dot = document.querySelector('.tview circle.pt')!;
    expect(dot).toBeInTheDocument();
    const motion = dot.querySelector('animateMotion')!;
    const normal = parseFloat(motion.getAttribute('dur')!);
    act(() => { reduce = true; changes.forEach(update => update()); });
    expect(document.querySelector('.tview circle.pt')).toBe(dot);
    expect(parseFloat(motion.getAttribute('dur')!)).toBeCloseTo(normal * 4, 1);
  });

  it('reloads for this department or its parent, and ignores tasks elsewhere', async () => {
    const stream = fakeStream();
    const user = userEvent.setup();
    const calls = shell(treeRoute());
    await showTree(user);
    const count = () => calls.filter(c => c.path === TREE_PATH).length;
    stream.send({ type: 'task', id: 'b42', spot: { departmentId: 'other' } });
    await act(async () => {});
    expect(count()).toBe(1);
    stream.send({ type: 'task', id: 'b42', spot: { departmentId: 'd2' } });
    await waitFor(() => expect(count()).toBe(2));
    stream.send({ type: 'task', id: 'b42', spot: { departmentId: 'product', parentId: 'd2' } });
    await waitFor(() => expect(count()).toBe(3));
  });

  it('refreshes every minute only while the tree data is on', async () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const calls = mockApi(treeRoute());
    const { rerender, unmount } = renderHook(({ on }) => useDepartmentTree('d2', on), { initialProps: { on: true } });
    await act(async () => {});
    expect(calls).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(calls).toHaveLength(2);
    rerender({ on: false });
    await act(async () => { vi.advanceTimersByTime(120_000); });
    expect(calls).toHaveLength(2);
    unmount();
  });

  it('names the buttons and explains a missing turn in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    onTestFinished(() => localStorage.removeItem('hh-lang'));
    const user = userEvent.setup();
    shell(treeRoute({ ...DEV_TREE, turn: null }));
    await user.click(await screen.findByRole('button', { name: /^Разработка/ }));
    await user.click(screen.getByRole('button', { name: 'Дерево' }));
    expect(await screen.findByText('Сейчас у отдела нет открытого хода.')).toBeInTheDocument();
    expect(within(document.querySelector('.dview') as HTMLElement).getByRole('button', { name: 'Карта' })).toHaveAttribute('title', 'Карта');
    expect(screen.getByRole('button', { name: 'Скорость' })).toHaveAttribute('title', 'Скорость');
  });

  it('keeps named icons and reduced-motion CSS', () => {
    expect(decl('.hbtn.ib', 'width')).toBe('44px');
    for (const selector of ['.tview .hd-d', '.tview .hd-c.ps', '.tview .ring.br']) {
      expect(decl(selector, 'animation', '(prefers-reduced-motion: reduce)')).toBe('none');
    }
  });
});

it('keeps attributed task findings visible and opens the current checker window', async () => {
  const user = userEvent.setup();
  shell(treeRoute(REVIEW_TREE), TREE_ORG);
  const graph = await showTree(user);
  await user.click(graph.querySelector('[data-row="b6"]')!);
  const card = await screen.findByRole('dialog');
  expect(within(card).getByRole('region', { name: 'Findings by stage' })).toHaveTextContent('Unique findings: 2');
  expect(within(card).getByRole('list', { name: 'Task workflow' }).querySelector('[aria-current="step"]')).toHaveTextContent('Owner: Vera');
  await user.click(within(within(card).getAllByRole('heading', { level: 4 })[0]!).getByRole('button'));
  expect(await screen.findByRole('complementary', { name: 'Vera, Backend engineer' })).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('measures wrapped actions for the tree floor and hides a ticker under 220 pixels', async () => {
  const callbacks: (() => void)[] = [];
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { callbacks.push(callback); }
    observe() {}
    disconnect() {}
  });
  const user = userEvent.setup();
  shell(treeRoute());
  await flyIn(user);
  const root = document.querySelector('.dview') as HTMLElement;
  const actions = root.querySelector('.dv-acts')!;
  Object.defineProperties(root, { clientWidth: { configurable: true, value: 1200 }, clientHeight: { configurable: true, value: 700 } });
  Object.defineProperties(actions, { offsetWidth: { configurable: true, value: 543 }, offsetLeft: { configurable: true, value: 641 }, offsetTop: { configurable: true, value: 500 } });
  act(() => callbacks.forEach(fn => fn()));
  expect(root.style.getPropertyValue('--ticker-right')).toBe('575px');
  expect(root.querySelector('.ticker')).toBeInTheDocument();
  Object.defineProperty(root, 'clientWidth', { configurable: true, value: 900 });
  act(() => callbacks.forEach(fn => fn()));
  expect(root.querySelector('.ticker')).not.toBeInTheDocument();
  vi.stubGlobal('innerWidth', 360);
  /* On a phone the zoom, the line of what happened and the bar stand in one dock: the tree ends above all of it. */
  Object.defineProperty(root.querySelector('.dv-dock')!, 'offsetTop', { configurable: true, value: 440 });
  act(() => callbacks.forEach(fn => fn()));
  expect(root.style.getPropertyValue('--tree-bottom')).toBe('268px');
});

describe('the department bar', () => {
  const PHONE = '(max-width: 760px)';
  const TOOLS = ['Tree', 'Speed', 'Department tasks', 'About the department'];

  function observed() {
    const callbacks: (() => void)[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { callbacks.push(callback); }
      observe() {}
      disconnect() {}
    });
    return () => act(() => callbacks.forEach(fn => fn()));
  }

  async function open(width?: number) {
    if (width) vi.stubGlobal('innerWidth', width);
    const user = userEvent.setup();
    shell(treeRoute(), TREE_ORG);
    await flyIn(user);
    return { user, acts: document.querySelector<HTMLElement>('.dv-acts')! };
  }

  /* Each tool as the bar shows it: its name, its tooltip, its words on the screen and its icons. */
  const tools = (acts: HTMLElement) =>
    [...acts.querySelectorAll('.dv-tools > button')].map(b => [b.getAttribute('aria-label'), b.getAttribute('title'), b.textContent, b.querySelectorAll('svg').length]);

  it.each([375, 320])('shows the tools on a %ipx phone as named icons in one group, and Hire in words at its end', async width => {
    const { acts } = await open(width);
    expect(acts).toHaveAttribute('data-fit', 'icons');
    expect(tools(acts)).toEqual(TOOLS.map(name => [name, name, '', 1]));
    for (const name of TOOLS) expect(within(acts).getByRole('button', { name })).toHaveClass('hbtn', 'ib');
    const hire = within(acts).getByRole('button', { name: '+ Hire' });
    expect(hire).toHaveTextContent('+ Hire');
    expect(acts.lastElementChild).toBe(hire);
  });

  it('opens the same drawers and pages from the icons on a phone', async () => {
    const { user, acts } = await open(375);
    expect(acts).toHaveAttribute('data-fit', 'icons');
    await user.click(screen.getByRole('button', { name: 'About the department' }));
    expect(screen.getByRole('complementary', { name: 'About the department' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About the department' })).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('button', { name: 'Department tasks' }));
    expect(location.pathname + location.search).toBe('/tasks?department=d2');
  });

  it('keeps the words of the tools on a wide screen while they fit beside the zoom, and icons when they do not', async () => {
    const measure = observed();
    const { acts } = await open();
    const root = document.querySelector<HTMLElement>('.dview')!;
    expect(acts).not.toHaveAttribute('data-fit');
    expect(within(acts).getByRole('button', { name: 'Department tasks' })).not.toHaveAttribute('title');
    expect(within(acts).getByRole('button', { name: 'Department tasks' })).toHaveTextContent('Department tasks');
    /* A language twice as long: the bar wants 900 px, and 1000 px of screen leave 772 after the zoom and the edge. */
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: 1000 });
    Object.defineProperty(acts, 'scrollWidth', { configurable: true, value: 900 });
    measure();
    expect(acts).toHaveAttribute('data-fit', 'icons');
    expect(tools(acts)).toEqual(TOOLS.map(name => [name, name, '', 1]));
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: 1440 });
    measure();
    expect(acts).not.toHaveAttribute('data-fit');
    expect(within(acts).getByRole('button', { name: 'About the department' })).toHaveTextContent('About the department');
  });

  it('stands the zoom, the line of what happened and the bar one over the other on a phone, the line across the width', async () => {
    await open(375);
    const dock = document.querySelector('.dview .dv-dock')!;
    expect([...dock.children].map(c => c.className.split(' ')[0])).toEqual(['dv-zoom', 'ticker', 'dv-acts']);
    expect(dock.querySelectorAll('.dv-zoom > .zoom')).toHaveLength(1);
    /* On a wide screen the dock draws nothing of its own: the zoom, the line and the bar keep their places. */
    expect(decl('.dv-dock', 'display')).toBe('contents');
    expect(decl('.dv-zoom', 'display')).toBe('contents');
    expect(decl('.dv-dock', 'display', PHONE)).toBe('flex');
    expect(decl('.dv-dock', 'flex-direction', PHONE)).toBe('column');
    expect(decl('.dv-dock', 'position', PHONE)).toBe('absolute');
    expect(decl('.dv-dock', 'inset-inline', PHONE)).toBe('16px');
    expect(decl('.dv-dock', 'inset-block-end', PHONE)).toBe('16px');
    expect(decl('.dv-dock', 'gap', PHONE)).toBe('8px');
    for (const part of ['.dv-dock .zoom', '.dv-dock > .ticker', '.dv-dock > .dv-acts']) expect(decl(part, 'position', PHONE)).toBe('static');
    /* The zoom keeps out and in and Show everything, at its end: a finger does not pinch the schema. */
    expect(decl('.dv-dock .zoom', 'align-self', PHONE)).toBe('flex-end');
    expect(decl('.dv-dock .zv', 'display', PHONE)).toBe('none');
    /* The line wraps its words over as many lines as it needs, on a phone and on a wide screen alike, where it grows up
       from the bottom between the zoom and the tools, as the orchestrator's line does on the map. */
    expect(decl('.ticker', 'white-space')).toBe('normal');
    expect(decl('.ticker', 'overflow')).toBe('visible');
    expect(decl('.dview .ticker', 'max-width')).toBe('none');
    expect(decl('.ticker .tx', 'overflow-wrap')).toBe('break-word');
    for (const part of ['.ticker', '.ticker .tx'])
      for (const rule of rulesFor(part)) {
        expect.soft(rule.decls['text-overflow'], part).not.toBe('ellipsis');
        expect.soft(rule.decls.overflow, part).not.toBe('hidden');
        expect.soft(rule.decls['white-space'], part).not.toBe('nowrap');
      }
    for (const part of ['.ticker', '.dv-dock > .ticker', '.ticker .tx', '.dv-dock .ticker .tx', '.ticker .live', '.dv-dock .ticker .live'])
      expect(rulesFor(part).filter(r => r.media === PHONE && ['white-space', 'overflow', 'text-overflow', 'overflow-wrap', 'align-items', 'padding-block', 'margin-block-start'].some(p => p in r.decls))).toEqual([]);
    /* A line of several rows keeps its dot and time on the first row; one row still stands in the middle of 44 px. */
    expect(decl('.ticker', 'align-items')).toBe('flex-start');
    expect(decl('.ticker', 'padding-block')).toBe('max(8px, calc((44px - 1lh) / 2))');
    expect(decl('.ticker .live', 'margin-block-start')).toBe('calc((1lh - 7px) / 2)');
  });

  it('ends the tree, the drawers and the hint of an empty schema above a line of what happened that grows on a wide screen', async () => {
    const measure = observed();
    await open(1440);
    const root = document.querySelector<HTMLElement>('.dview')!;
    const ticker = root.querySelector<HTMLElement>('.ticker')!;
    Object.defineProperties(root, { clientWidth: { configurable: true, value: 1440 }, clientHeight: { configurable: true, value: 900 } });
    /* One line, 44 px from 16 px over the bottom: they end where they always did. */
    Object.defineProperty(ticker, 'offsetTop', { configurable: true, value: 900 - 16 - 44 });
    measure();
    expect(root.style.getPropertyValue('--tree-bottom')).toBe('76px');
    /* Three lines: 16 px over its top. */
    Object.defineProperty(ticker, 'offsetTop', { configurable: true, value: 900 - 16 - 80 });
    measure();
    expect(root.style.getPropertyValue('--tree-bottom')).toBe(`${16 + 80 + 16}px`);
    for (const part of ['.tview', '.dv-drawer']) expect(decl(part, 'bottom')).toBe('var(--tree-bottom, 76px)');
    expect(decl('.dv-empty', 'bottom')).toBe('var(--tree-bottom, 76px)');
  });

  /* The Head of Design's word for #1489 (#1539, N2): the line of what happened takes at most three lines; a longer one folds
     to three, and its own button unfolds it whole and folds it again. */
  it.each([['en', 'Show all of it', 'Show less'], ['ru', ru.dept.hintMore, ru.dept.hintLess]] as const)(
    'folds a line of what happened longer than three lines, and unfolds it whole by its button (%s)', async (language, more, less) => {
      localStorage.setItem('hh-lang', language);
      onTestFinished(() => localStorage.removeItem('hh-lang'));
      const measure = observed();
      const user = userEvent.setup();
      shell(treeRoute(), TREE_ORG);
      await user.click(await screen.findByRole('button', { name: new RegExp(`^${language === 'en' ? 'Development' : 'Разработка'}`) }));
      const ticker = await waitFor(() => document.querySelector<HTMLElement>('.dview .ticker')!);
      const fold = ticker.querySelector<HTMLElement>('.tx-fold')!, words = ticker.querySelector<HTMLElement>('.tx')!;
      /* The words read in their own direction, and a line that fits has nothing to unfold. */
      expect(words).toHaveAttribute('dir', 'auto');
      expect(fold).toHaveClass('folded');
      Object.defineProperty(fold, 'clientHeight', { configurable: true, value: 57 });
      Object.defineProperty(words, 'offsetHeight', { configurable: true, value: 57 });
      measure();
      expect(ticker.querySelector('button')).toBeNull();
      /* Six lines: three show, and the button says what it does. */
      Object.defineProperty(words, 'offsetHeight', { configurable: true, value: 114 });
      measure();
      const button = within(ticker).getByRole('button', { name: more });
      expect(button).toHaveAttribute('aria-expanded', 'false');
      expect(button).toHaveAttribute('aria-controls', fold.id);
      await user.click(button);
      expect(fold).not.toHaveClass('folded');
      expect(within(ticker).getByRole('button', { name: less })).toHaveAttribute('aria-expanded', 'true');
      await user.click(within(ticker).getByRole('button', { name: less }));
      expect(fold).toHaveClass('folded');
      /* Folded, it shows three lines and hides the rest until it is unfolded. */
      expect(decl('.ticker .tx-fold.folded', 'max-block-size')).toBe('3lh');
      expect(decl('.ticker .tx-fold.folded', 'overflow')).toBe('hidden');
      expect([en.dept.hintMore, en.dept.hintLess]).toEqual(['Show all of it', 'Show less']);
    });

  it('puts the zoom of the tree in the same dock, the only zoom on the screen', async () => {
    const { user } = await open(375);
    await user.click(screen.getByRole('button', { name: 'Tree' }));
    await screen.findByRole('group', { name: 'Tree of turn 3' });
    const dock = document.querySelector('.dview .dv-dock')!;
    expect([...dock.children].map(c => c.className.split(' ')[0])).toEqual(['dv-zoom', 'ticker', 'dv-acts']);
    expect(document.querySelectorAll('.dview .zoom')).toHaveLength(1);
    expect(within(dock.querySelector<HTMLElement>('.dv-zoom')!).getByRole('button', { name: 'Show everything' })).toBeInTheDocument();
  });

  it('draws the icons as one strip of 44 px cells, and puts Hire at the end, on its own row when it does not fit', () => {
    const icons = '.dv-acts[data-fit="icons"]';
    expect(decl('.dv-tools', 'display')).toBe('contents');
    expect(decl(`${icons} .dv-tools`, 'display')).toBe('flex');
    expect(decl(`${icons} .dv-tools`, 'outline')).toBe('1px solid var(--line)');
    expect(decl(`${icons} .dv-tools`, 'outline-offset')).toBe('-1px');
    expect(decl(`${icons} .dv-tools`, 'border')).toBe('0');
    expect(decl(`${icons} .dv-tools > .hbtn`, 'border')).toBe('0');
    expect(decl(`${icons} .dv-tools > .hbtn`, 'background')).toBe('none');
    expect(decl(`${icons} .dv-tools > .hbtn + .hbtn`, 'border-inline-start')).toBe('1px solid var(--line)');
    expect(decl('.hbtn.ib', 'width')).toBe('44px');
    expect(decl('.hbtn.ib', 'height')).toBe('44px');
    expect(decl(`${icons} > .btn`, 'margin-inline-start')).toBe('auto');
    expect(decl('.dv-acts', 'flex-wrap', PHONE)).toBe('wrap');
    /* Words of a tool stay on one line while they show; when they do not fit, the tools turn to icons. */
    expect(decl('.hbtn', 'white-space')).toBe('nowrap');
  });

  it('lets the name of the department wrap on a phone, and starts the tree and the drawers under it', () => {
    /* The name wraps on every screen, which gives it the whole width under the menu (#1635). */
    for (const prop of ['white-space', 'overflow', 'text-overflow', 'overflow-wrap']) expect(decl('.crumbs h2', prop, PHONE)).toBeUndefined();
    expect(decl('.crumbs', 'max-width')).toBe('calc(100% - 2 * var(--bar-edge))');
    expect(decl('.crumbs', 'max-width', PHONE)).toBeUndefined();
    expect(decl('.dv-drawer', 'top', PHONE)).toBe('var(--tree-top, 116px)');
    expect(decl('.tview', 'top', PHONE)).toBe('var(--tree-top, 116px)');
  });

  it('measures where the name of the department ends for the tree and drawers on a phone', async () => {
    const measure = observed();
    await open(375);
    const root = document.querySelector<HTMLElement>('.dview')!;
    Object.defineProperties(root.querySelector('.crumbs')!, { offsetTop: { configurable: true, value: 64 }, offsetHeight: { configurable: true, value: 70 } });
    measure();
    expect(root.style.getPropertyValue('--tree-top')).toBe('142px');
  });

  /* The name stands 8 px under the menu on a wide screen too, its 44 px blocks 12 px from the top (#1635), and the tree 8 px
     under the name as tall as it wraps (#1610). It moves there by transform, which offsetTop does not see. */
  it('wraps a name of the department too long for its room on a wide screen, and starts the tree and drawers under it', async () => {
    const measure = observed();
    await open(1440);
    const root = document.querySelector<HTMLElement>('.dview')!;
    const crumbs = root.querySelector<HTMLElement>('.crumbs')!;
    Object.defineProperties(crumbs, { offsetTop: { configurable: true, value: 0 }, offsetHeight: { configurable: true, value: 44 } });
    measure();
    expect(root.style.getPropertyValue('--tree-top')).toBe(`${64 + 44 + 8}px`);
    Object.defineProperty(crumbs, 'offsetHeight', { configurable: true, value: 70 });
    measure();
    expect(root.style.getPropertyValue('--tree-top')).toBe(`${64 + 70 + 8}px`);
    for (const part of ['.tview', '.dv-drawer']) expect(decl(part, 'top')).toBe('var(--tree-top, 68px)');
    expect(decl('.crumbs h2', 'white-space')).toBe('normal');
    expect(decl('.crumbs h2', 'overflow-wrap')).toBe('break-word');
    for (const rule of rulesFor('.crumbs h2')) expect([rule.decls.overflow, rule.decls['text-overflow']]).not.toContain('hidden');
    for (const rule of rulesFor('.crumbs h2')) expect(rule.decls['text-overflow']).not.toBe('ellipsis');
    expect([decl('.crumbs', 'height'), decl('.crumbs', 'align-items'), decl('.crumb', 'height'), decl('.crumb', 'min-height')]).toEqual(['auto', 'flex-start', 'auto', '44px']);
  });

  /* The name no longer stands beside the logo (#1635): however long it is, the tabs keep the room between the logo and the
     account, and keep their words while those fit it. */
  it('leaves the tabs their room between the logo and the account on a wide screen, however long its name is', async () => {
    const measure = observed();
    await open();
    const root = document.querySelector<HTMLElement>('.dview')!;
    const crumbs = root.querySelector<HTMLElement>('.crumbs')!;
    const name = crumbs.querySelector<HTMLElement>('h2')!;
    const bar = document.querySelector<HTMLElement>('.topbar')!;
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: 1024 });
    Object.defineProperty(bar, 'clientWidth', { configurable: true, value: 992 });
    Object.defineProperty(document.querySelector('.tb-brand')!, 'offsetWidth', { configurable: true, value: 44 });
    Object.defineProperty(document.querySelector('.tb-right')!, 'offsetWidth', { configurable: true, value: 44 });
    Object.defineProperty(nav, 'scrollWidth', { configurable: true, value: 400 });
    /* A name of 220 px that wants 120 px more once took 340 px beside the logo and left the tabs 224: now the tabs have
       992 - 2 * 52 = 888, room for their 400 px of words. */
    Object.defineProperty(crumbs, 'offsetWidth', { configurable: true, value: 220 });
    Object.defineProperties(name, { scrollWidth: { configurable: true, value: 240 }, clientWidth: { configurable: true, value: 120 } });
    measure();
    expect(nav).not.toHaveAttribute('data-fit');
  });
});

it('keeps a dismissed agent window from Speed closed after live data changes', async () => {
  const user = userEvent.setup(), stream = fakeStream();
  shell(treeRoute(), TREE_ORG);
  await flyIn(user);
  await user.click(screen.getByRole('button', { name: 'Speed' }));
  const speed = screen.getByRole('complementary', { name: 'Speed' });
  await user.click(await within(speed).findByRole('button', { name: /Bruno/ }));
  const window = await screen.findByRole('complementary', { name: 'Bruno, Backend engineer' });
  await user.click(within(window).getByRole('button', { name: 'Close' }));
  expect(window).not.toBeInTheDocument();
  stream.send({ type: 'task', id: 'b42', spot: { departmentId: 'd2' } });
  await act(async () => {});
  expect(screen.queryByRole('complementary', { name: 'Bruno, Backend engineer' })).not.toBeInTheDocument();
});

it('places a short card below its point when it fits there', async () => {
  const user = userEvent.setup();
  shell(treeRoute());
  const graph = await showTree(user);
  const hit = within(graph).getByRole('button', { name: 'main' });
  vi.spyOn(hit, 'getBoundingClientRect').mockReturnValue({ x: 200, y: 150, left: 200, right: 500, top: 150, bottom: 200, width: 300, height: 50, toJSON() {} });
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!;
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.classList.contains('tv-card') ? 180 : 0; } });
  onTestFinished(() => { Object.defineProperty(HTMLElement.prototype, 'offsetHeight', descriptor); });
  await user.click(hit);
  expect(screen.getByRole('dialog')).toHaveStyle({ top: '208px' });
});

it('shows the task number beside an agent in Speed and opens an idle agent window', async () => {
  const user = userEvent.setup();
  shell(treeRoute(), TREE_ORG);
  await flyIn(user);
  await user.click(screen.getByRole('button', { name: 'Speed' }));
  const speed = screen.getByRole('complementary', { name: 'Speed' });
  const bruno = await within(speed).findByRole('button', { name: /Bruno/ });
  expect(bruno).toHaveTextContent('#42');
  await user.click(within(speed).getByRole('button', { name: /Ostap/ }));
  expect(await screen.findByRole('complementary', { name: 'Ostap, Backend engineer' })).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

describe("what an agent's program does, and the server's alarms about its turn", () => {
  type Live = Pick<Employee, 'program' | 'alarm'> & Partial<Pick<Employee, 'status' | 'retry'>>;
  const ago = (now: number, minutes: number) => now - minutes * 60_000;
  /* The company with Bruno's program and alarm as given, on a server clock at now. */
  function live(now: number, bruno: Live, base: Org = TREE_ORG): Org {
    return { ...base, serverNow: new Date(now).toISOString(), departments: base.departments.map(d => ({ ...d, employees: d.employees.map(e => (e.id === 'b1' ? { ...e, ...bruno } : e)) })) };
  }
  const program = (now: number, state: ProgramView['state'], minutes: number, tool: string | null = null): ProgramView => ({ state, since: ago(now, minutes), tool, screenAt: ago(now, 0), signAt: null, retry: null, reportedAt: ago(now, 0) });
  const retryAt = new Date(2026, 10, 3, 14, 5).getTime();
  const STATES: [string, (now: number) => Live, string, string, boolean][] = [
    ['thinking', now => ({ program: program(now, 'thinking', 12), alarm: null }), 'thinking 12 min', 'думает 12 мин', false],
    ['thinking with no sign', now => ({ program: { ...program(now, 'thinking', 32), signAt: ago(now, 31) }, alarm: null }), 'thinking 32 min, no sign 31 min', 'думает 32 мин, без признаков 31 мин', false],
    ['a tool', now => ({ program: program(now, 'tool', 40, 'Bash'), alarm: null }), 'Bash running 40 min', 'Bash работает 40 мин', false],
    ['asking', now => ({ program: program(now, 'asking', 3), alarm: null }), 'asking', 'спрашивает', false],
    ['retrying', now => ({ program: program(now, 'retrying', 3), alarm: null }), 'retrying', 'повторяет запрос', false],
    ['a waiting retry', () => ({ program: null, alarm: null, retry: { attempt: 2, max: 4, at: retryAt, kind: 'overloaded' } }), 'retry 2 of 4 at 14:05 (provider overloaded)', 'повтор 2 из 4 в 14:05 (провайдер перегружен)', false],
    ['waiting for input after 5 min', now => ({ program: program(now, 'idle', 5), alarm: null }), 'waiting for input', 'ждет ввода', false],
    ['a frozen program', now => ({ program: program(now, 'thinking', 50), alarm: { reason: 'program_stalled', since: ago(now, 34) } }), 'program frozen 34 min', 'программа замерла 34 мин', true],
    ['a silent node', now => ({ program: program(now, 'tool', 45, 'Bash'), alarm: { reason: 'node_silent', since: ago(now, 31) } }), 'node silent 31 min', 'нода молчит 31 мин', true],
  ];
  const stateOf = (where: HTMLElement) => where.querySelector('.ast');
  /* Every clock of the page moves only when the test moves it. Testing Library's findBy* and userEvent wait on a timer of
     that clock, so the test clicks with fireEvent and looks with vi.waitFor, which moves the clock 50 ms a look. */
  function heldClock() {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
  }
  const bruno = () => within(screen.getByRole('region', { name: /^(Members|Сотрудники)$/ })).getByRole('button', { name: /Bruno/ });
  const lane = () => [...document.querySelectorAll<HTMLElement>('.tv-labs .dept-chip .schip')].find(b => b.textContent!.includes('Bruno'))!;

  describe.each([
    ['en', /^Development/, 'Tree'],
    ['ru', /^Разработка/, 'Дерево'],
  ] as const)('in %s', (lang, department, tree) => {
    it.each(STATES)('shows %s on the agent on the map and in the tree', async (_, state, en, ru, alarm) => {
      localStorage.setItem('hh-lang', lang);
      onTestFinished(() => localStorage.removeItem('hh-lang'));
      /* The page's steady clock stands still, so 59 and 61 seconds stay what they are while the test runs. */
      vi.useFakeTimers({ toFake: ['performance'] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const user = userEvent.setup();
      const now = Date.now();
      shell(treeRoute({ ...DEV_TREE, now: new Date(now).toISOString() }), live(now, state(now)));
      await user.click(await screen.findByRole('button', { name: department }));
      const text = lang === 'en' ? en : ru;
      for (const where of [bruno]) {
        expect(stateOf(where())).toHaveTextContent(text);
        expect(stateOf(where())!.classList.contains('alarm')).toBe(alarm);
      }
      await user.click(screen.getByRole('button', { name: tree }));
      await screen.findByRole('group');
      await user.click(lane());
      const card = await screen.findByRole('dialog');
      expect(stateOf(card)).toHaveTextContent(text);
      expect(stateOf(card)!.classList.contains('alarm')).toBe(alarm);
      /* Where a phone's label cuts it short, the whole of it is a touch away. */
      expect(stateOf(card)).toHaveAttribute('title', text);
    });

    it('says in the tree that an agent without a running turn waits for a task, and nothing of it on the schema, which says so already', async () => {
      localStorage.setItem('hh-lang', lang);
      onTestFinished(() => localStorage.removeItem('hh-lang'));
      const user = userEvent.setup();
      const now = Date.now();
      shell(treeRoute({ ...DEV_TREE, now: new Date(now).toISOString() }), live(now, { program: null, alarm: null, status: 'idle' }));
      await user.click(await screen.findByRole('button', { name: department }));
      expect(stateOf(bruno())).toBeNull();
      await user.click(screen.getByRole('button', { name: tree }));
      await screen.findByRole('group');
      await user.click(lane());
      expect(stateOf(await screen.findByRole('dialog'))).toHaveTextContent(lang === 'en' ? 'waiting for a task' : 'ждет задачу');
    });
  });

  it('counts the minutes on without a reload, keeps a long wait for input calm, and follows the server when it says the company changed', async () => {
    heldClock();
    const stream = fakeStream();
    const now = Date.now();
    let org = live(now, { program: program(now, 'thinking', 12), alarm: null }, DEV_ORG);
    shell({ 'GET /api/org': async () => [200, org] });
    fireEvent.click(await vi.waitFor(() => screen.getByRole('button', { name: /^Development/ })));
    await vi.waitFor(() => screen.getByRole('heading', { level: 2, name: 'Development' }));
    expect(stateOf(bruno())).toHaveTextContent('thinking 12 min');
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(stateOf(bruno())).toHaveTextContent('thinking 13 min');
    /* It waits for input from the minute the held clock just passed, and stays calm past a minute. */
    org = live(now, { program: program(now, 'idle', -1), alarm: null }, DEV_ORG);
    stream.send({ type: 'org' });
    await vi.waitFor(() => expect(stateOf(bruno())).toHaveTextContent('waiting for input'));
    expect(stateOf(bruno())).not.toHaveClass('alarm');
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(stateOf(bruno())).toHaveTextContent('waiting for input');
    expect(stateOf(bruno())).not.toHaveClass('alarm');
    org = live(now, { program: null, alarm: null }, DEV_ORG);
    stream.send({ type: 'working', working: 0 });
    await vi.waitFor(() => expect(stateOf(bruno())).toBeNull());
  });

  it.each([
    ['en', 'Card', 'program frozen 34 min'],
    ['ru', 'Карточка', 'программа замерла 34 мин'],
  ])("shows it on the agent's card opened from the department, in %s", async (lang, card, text) => {
    localStorage.setItem('hh-lang', lang);
    onTestFinished(() => localStorage.removeItem('hh-lang'));
    /* The page's steady clock stands still, so 34 minutes stay what they are while the test runs. */
    vi.useFakeTimers({ toFake: ['performance'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const user = userEvent.setup();
    const now = Date.now();
    const routes = { 'GET /api/agents/b1': [200, { ...CARD, state: 'working' }], 'GET /api/agents/b1/events?last=300': [200, { events: [], state: READY }] };
    shell(routes, live(now, { program: program(now, 'thinking', 50), alarm: { reason: 'program_stalled', since: ago(now, 34) } }, DEV_ORG));
    await user.click(await screen.findByRole('button', { name: lang === 'en' ? /^Development/ : /^Разработка/ }));
    await user.click(screen.getByRole('button', { name: /Bruno/ }));
    await user.click(await screen.findByRole('button', { name: card }));
    const head = (await screen.findByRole('heading', { level: 3, name: 'Bruno' })).parentElement!;
    expect(stateOf(head)).toHaveTextContent(text);
    expect(stateOf(head)).toHaveClass('alarm');
  });
});

describe("a department's branches not in main yet", () => {
  const BRANCHES = {
    branches: [
      { task: 41, title: 'Lead scoring', status: 'review', branch: 'task-41-scoring', commit: 'b'.repeat(40), merged: false },
      { task: 37, title: 'Collect leads', status: 'done', branch: 'task-37', commit: 'a'.repeat(40), merged: null },
    ],
    problem: null,
  };
  const withRepo = () => {
    const [dev] = DEV_ORG.departments;
    return { ...DEV_ORG, departments: [{ ...dev!, repository: REPO }] };
  };
  afterEach(() => localStorage.removeItem('hh-lang'));

  it.each([
    ['en', 'Branches not in main yet', ['#41 Lead scoring', 'task-41-scoring', 'Handed in, not in main yet'], ['#37 Collect leads', 'task-37', 'Accepted, not known whether it is in main']],
    ['ru', 'Ветки, еще не влитые в main', ['#41 Lead scoring', 'task-41-scoring', 'Сдана, еще не в main'], ['#37 Collect leads', 'task-37', 'Принята, неизвестно, есть ли она в main']],
  ])('lists to the people who run it in %s which accepted and handed-in task branches are not in main', async (language, heading, first, second) => {
    localStorage.setItem('hh-lang', language);
    const user = userEvent.setup();
    shell({ [DEV_TASKS]: [200, { tasks: [] }], 'GET /api/departments/d2/branches': [200, BRANCHES] }, withRepo());
    await user.click(await screen.findByRole('button', { name: language === 'en' ? /^Development/ : /^Разработка/ }));
    await user.click(await screen.findByRole('button', { name: language === 'en' ? 'About the department' : ru.dept.about }));
    const region = await screen.findByRole('region', { name: heading });
    const items = (await within(region).findAllByRole('listitem')).map(li => li.textContent!);
    expect(items).toHaveLength(2);
    for (const said of first) expect(items[0]).toContain(said);
    for (const said of second) expect(items[1]).toContain(said);
  });

  it('says when every accepted branch is in main, and why the branches could not be read', async () => {
    const user = userEvent.setup();
    shell({ [DEV_TASKS]: [200, { tasks: [] }], 'GET /api/departments/d2/branches': [200, { branches: [], problem: null }] }, withRepo());
    await flyIn(user);
    await drawer(user, 'About the department');
    expect(await screen.findByText('Every accepted branch of the department is in main.')).toBeInTheDocument();
    cleanup();
    history.replaceState(null, '', '/');
    const again = userEvent.setup();
    shell({ [DEV_TASKS]: [200, { tasks: [] }], 'GET /api/departments/d2/branches': [200, { branches: [], problem: 'Hornhoof could not read the branches of https://github.com/acme/app.git: it answered 404.' }] }, withRepo());
    await flyIn(again);
    await drawer(again, 'About the department');
    expect(await screen.findByText('Hornhoof could not read the branches of https://github.com/acme/app.git: it answered 404.')).toBeInTheDocument();
  });

  it('is neither shown nor asked for where the department has no repository or the reader does not run it', async () => {
    const user = userEvent.setup();
    const calls = shell({ [DEV_TASKS]: [200, { tasks: [] }], 'GET /api/departments/d2/branches': [200, BRANCHES] }, withRepo(), listed('p7', 'Kira'));
    await flyIn(user);
    await drawer(user, 'About the department');
    expect(screen.queryByRole('region', { name: 'Branches not in main yet' })).not.toBeInTheDocument();
    expect(calls.some(c => c.path.endsWith('/branches'))).toBe(false);
    cleanup();
    history.replaceState(null, '', '/');
    const ceo = userEvent.setup();
    const noRepo = shell({ [DEV_TASKS]: [200, { tasks: [] }], 'GET /api/departments/d2/branches': [200, BRANCHES] });
    await flyIn(ceo);
    await drawer(ceo, 'About the department');
    expect(screen.queryByRole('region', { name: 'Branches not in main yet' })).not.toBeInTheDocument();
    expect(noRepo.some(c => c.path.endsWith('/branches'))).toBe(false);
  });
});
