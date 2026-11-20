import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { en } from '../src/i18n/en';
import { AgentWindow } from '../src/screens/AgentWindow';
import { DepartmentView } from '../src/screens/Department';
import { MapScreen } from '../src/screens/Map';
import { Shell } from '../src/screens/Shell';
import type { DepartmentTree, Org } from '../src/types';
import { CARD, DEV_ORG, ME, mockApi, ORG } from './api-mock';

/* Ivan's rule of 20.11 (#1620): a section says it is empty only once every source of it came. Until then it holds its room
   with the shared indicator, never "nothing here" while a source is still on its way. Each test holds back one source of a
   section with an empty state, and fails if that empty state shows before the source came. */

/* An answer the test lets go. */
function held(answer: [number, unknown]) {
  let release = () => {};
  const comes = new Promise<[number, unknown]>(resolve => { release = () => resolve(answer); });
  return { route: () => comes, release: () => act(async () => release()) };
}

const settle = () => act(async () => {});
const READY = { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 };
const NO_HISTORY: [number, unknown] = [200, { events: [], state: READY }];

/* The company has no departments, and its department d2 no employee but its head. */
const NO_DEPARTMENTS: Org = { ...ORG, departments: [] };
const HEAD_ONLY: Org = { ...DEV_ORG, departments: DEV_ORG.departments.map(d => ({ ...d, employees: d.employees.filter(e => e.kind === 'head') })) };
const NO_TURN: DepartmentTree = { now: '2026-11-20T02:00:00.000Z', turn: null, repository: true, lines: [], time: [], idle: [] };

afterEach(() => window.history.replaceState(null, '', '/'));

describe('the map says it has no departments only once', () => {
  const map = () => render(<LanguageProvider><MapScreen me={ME} windowOpen={false} onOpenOrchestrator={() => {}} /></LanguageProvider>);

  it("the person's arrangement came too", async () => {
    const layout = held([200, { blocks: {} }]);
    mockApi({ 'GET /api/org': [200, NO_DEPARTMENTS], 'GET /api/map/layout': layout.route });
    map();
    await settle();
    expect(screen.queryByText(en.map.emptyHint)).not.toBeInTheDocument();
    await layout.release();
    expect(await screen.findByText(en.map.emptyHint)).toBeInTheDocument();
  });

  it('the company came', async () => {
    const org = held([200, NO_DEPARTMENTS]);
    mockApi({ 'GET /api/org': org.route, 'GET /api/map/layout': [200, { blocks: {} }] });
    map();
    await settle();
    expect(screen.queryByText(en.map.emptyHint)).not.toBeInTheDocument();
    await org.release();
    expect(await screen.findByText(en.map.emptyHint)).toBeInTheDocument();
  });
});

describe('a department says it has no employees', () => {
  it('only once the company came', async () => {
    const org = held([200, HEAD_ONLY]);
    mockApi({ 'GET /api/org': org.route });
    window.history.replaceState(null, '', '/departments/d2');
    render(<LanguageProvider><Shell me={ME} onSignOut={() => {}} /></LanguageProvider>);
    await settle();
    expect(screen.queryByText(en.dept.noMembers)).not.toBeInTheDocument();
    await org.release();
    expect(await screen.findByText(en.dept.noMembers)).toBeInTheDocument();
  });
});

describe('a department says it runs no turn', () => {
  it.each([['tree', en.dept.treeButton], ['speed drawer', en.dept.speed]])('in its %s only once the work tree came', async (_, button) => {
    const user = userEvent.setup();
    const tree = held([200, { tree: NO_TURN }]);
    mockApi({ 'GET /api/departments/d2/tree': tree.route });
    render(<LanguageProvider><DepartmentView me={ME} department={DEV_ORG.departments[0]!} deputies={[]} selected={null} panel={null}
      onBack={() => {}} onHire={() => {}} onOpen={() => {}} onOpenTask={() => {}} /></LanguageProvider>);
    await user.click(screen.getByRole('button', { name: button }));
    await settle();
    expect(screen.queryByText(en.dept.treeNoTurn)).not.toBeInTheDocument();
    await tree.release();
    expect(await screen.findByText(en.dept.treeNoTurn)).toBeInTheDocument();
  });
});

describe("an agent's conversation says it has no messages", () => {
  const EMPLOYEE = { ...CARD, id: 'b1', name: 'Bruno', kind: 'worker' as const };
  const openWindow = (agentId: string) => render(<LanguageProvider><AgentWindow me={ME} org={DEV_ORG} agentId={agentId} onClose={() => {}} /></LanguageProvider>);

  it("only once an employee's history came", async () => {
    const history = held(NO_HISTORY);
    mockApi({ 'GET /api/agents/b1': [200, EMPLOYEE], 'GET /api/agents/b1/events?last=300': history.route });
    openWindow('b1');
    await settle();
    expect(screen.queryByText(en.window.chat.empty)).not.toBeInTheDocument();
    await history.release();
    expect(await screen.findByText(en.window.chat.empty)).toBeInTheDocument();
  });

  it("only once an employee's card came", async () => {
    const card = held([200, EMPLOYEE]);
    mockApi({ 'GET /api/agents/b1': card.route, 'GET /api/agents/b1/events?last=300': NO_HISTORY });
    openWindow('b1');
    await settle();
    expect(screen.queryByText(en.window.chat.empty)).not.toBeInTheDocument();
    await card.release();
    expect(await screen.findByText(en.window.chat.empty)).toBeInTheDocument();
  });

  it("only once the CEO's machine commands came, in the orchestrator's window", async () => {
    const commands = held([200, { commands: [] }]);
    mockApi({
      'GET /api/agents/orchestrator': [200, { ...CARD, id: 'a1', kind: 'orchestrator', name: 'Orchestrator', role: null, department: null }],
      'GET /api/agents/orchestrator/events?last=300': NO_HISTORY,
      'POST /api/agents/orchestrator/start': [200, { started: false }],
      'GET /api/nodes/commands': commands.route,
    });
    openWindow('orchestrator');
    await settle();
    expect(screen.queryByText(en.window.chat.empty)).not.toBeInTheDocument();
    await commands.release();
    expect(await screen.findByText(en.window.chat.empty)).toBeInTheDocument();
  });
});
