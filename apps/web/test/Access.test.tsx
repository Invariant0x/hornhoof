import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiFailure } from '../src/api';
import { LanguageProvider } from '../src/i18n';
import { AgentWindows, useAgentWindows } from '../src/screens/AgentWindows';
import { departmentIsMissing, RouteUnavailable } from '../src/screens/RouteUnavailable';
import { TreeView } from '../src/screens/TreeView';
import type { Me, Org } from '../src/types';
import { CARD, DEV_ORG, DEV_TREE, ME, mockApi, TREE_ORG } from './api-mock';
import { fakeStream } from './fake-stream';
import { visibleDepartmentTree } from '../src/screens/tree-access';

const STATE = { ready: true, reason: null, busy: false, runningJobId: null, queued: 0, terminal: false };
const SECRET = 'Private journal of an inaccessible agent';
const EVENTS_REPLY: [number, unknown] = [200, { events: [{ seq: 1, kind: 'text', data: { text: SECRET }, jobId: null, person: null, at: '2026-10-30T09:00:00.000Z' }], state: STATE }];
const allowed: Parameters<typeof mockApi>[0] = {
  'GET /api/agents/b1': [200, CARD],
  'GET /api/agents/b1/events?last=300': EVENTS_REPLY,
  'GET /api/nodes/commands': [200, { commands: [] }],
  'GET /api/machines/access': [200, { views: [] }],
};
const refused: [number, unknown] = [403, { error: { code: 'forbidden', message: 'Hidden resource details.' } }];

/* The windows open, by agent, beside them: a window that closes shows there as gone. */
function Windows({ me = ME, org = DEV_ORG, id = 'b1' }: { me?: Me; org?: Org; id?: string }) {
  const windows = useAgentWindows(id);
  return <LanguageProvider><AgentWindows windows={windows} onOpen={() => {}} me={me} org={org} staff={null} requests={[]} onRequestsChanged={() => {}} /><div data-testid="open-windows">{windows.ids.join(' ')}</div></LanguageProvider>;
}
/* The window closed: nothing of it can ask the server or show anything after this. */
const closed = () => waitFor(() => expect(screen.getByTestId('open-windows')).toBeEmptyDOMElement());

describe('restricted access screens', () => {
  it('uses the plain access-denied wording', () => {
    render(<LanguageProvider><RouteUnavailable /></LanguageProvider>);
    expect(screen.getByRole('heading', { name: 'Insufficient permissions' })).toBeInTheDocument();
  });

  it('shows only the employees and work present in a restricted department', () => {
    const full = TREE_ORG.departments.find(d => d.id === 'd2')!;
    const department = { ...full, employees: full.employees.filter(e => e.id === 'b1') };
    render(<LanguageProvider><TreeView tree={DEV_TREE} department={department} onOpenTask={() => {}} /></LanguageProvider>);
    expect(document.querySelectorAll('.tv-labs .dept-chip')).toHaveLength(1);
    expect(screen.getByText('Bruno')).toBeInTheDocument();
    expect(screen.queryByText('Timur')).not.toBeInTheDocument();
    expect(screen.queryByText('Payment screen in the app')).not.toBeInTheDocument();
    expect(document.querySelector('.tv-in')).not.toHaveTextContent('Payment screen in the app');
  });

  it.each([403, 404])('shows an access-denied window without the agent name or payload after %s', async status => {
    const denied: [number, unknown] = [status, { error: { code: status === 403 ? 'forbidden' : 'not_found', message: 'Hidden resource details.' } }];
    mockApi({ 'GET /api/agents/b1': denied, 'GET /api/agents/b1/events?last=300': denied });
    render(<Windows />);
    expect(await screen.findByRole('heading', { name: 'Insufficient permissions' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(screen.queryByText('Bruno')).not.toBeInTheDocument();
    expect(screen.queryByText('Hidden resource details.')).not.toBeInTheDocument();
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });

  it('opens a product employee authorized by the server without a department roster entry', async () => {
    const org = { ...DEV_ORG, departments: DEV_ORG.departments.map(d => ({ ...d, employees: [], products: [{ id: 'product', name: 'Checkout' }] })) };
    mockApi({ ...allowed, 'GET /api/agents/b1': [200, { ...CARD, product: { id: 'product', name: 'Checkout' } }] });
    render(<Windows org={org} />);
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Insufficient permissions' })).not.toBeInTheDocument();
  });

  it("keeps a person's own assistant window open, not built again, while the company refreshes", async () => {
    const calls = mockApi({ ...allowed, 'GET /api/agents/b1': [200, { ...CARD, kind: 'assistant', department: null, role: null }] });
    const org = { ...DEV_ORG, departments: DEV_ORG.departments.map(d => ({ ...d, employees: d.employees.filter(e => e.id !== 'b1') })) };
    const { rerender } = render(<Windows org={org} />);
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
    for (let i = 0; i < 3; i++) {
      rerender(<Windows org={{ ...org }} />);
      expect(screen.getByText(SECRET)).toBeInTheDocument();
      await waitFor(() => expect(calls.filter(c => c.path === '/api/agents/b1').length).toBeGreaterThan(i + 1));
    }
    expect(screen.getByText(SECRET)).toBeInTheDocument();
    expect(calls.filter(c => c.path === '/api/agents/b1/events?last=300')).toHaveLength(1);
  });

  it('drops an open agent journal as soon as a new org removes the agent', async () => {
    let access = true;
    mockApi({ ...allowed, 'GET /api/agents/b1': () => access ? [200, CARD] : refused });
    const { rerender } = render(<Windows />);
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
    const restricted = { ...DEV_ORG, departments: DEV_ORG.departments.map(d => ({ ...d, employees: d.employees.filter(e => e.id !== 'b1') })) };
    access = false;
    rerender(<Windows org={restricted} />);
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Insufficient permissions' })).toBeInTheDocument();
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('drops an open agent journal when a stream refresh returns 403', async () => {
    const stream = fakeStream();
    let access = true;
    mockApi({
      ...allowed,
      'GET /api/agents/b1': () => access ? [200, CARD] : refused,
      'GET /api/agents/b1/events?last=300': () => access ? EVENTS_REPLY : refused,
    });
    render(<Windows />);
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
    access = false;
    stream.send({ type: 'org' });
    expect(await screen.findByRole('heading', { name: 'Insufficient permissions' })).toBeInTheDocument();
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('closes the window of an employee the company says this person does not open, without asking the server', async () => {
    const calls = mockApi(allowed);
    const org = { ...DEV_ORG, departments: DEV_ORG.departments.map(d => ({ ...d, employees: d.employees.map(e => ({ ...e, opens: e.id !== 'b1' })) })) };
    render(<Windows org={org} />);
    await closed();
    expect(screen.queryByRole('heading', { name: 'Insufficient permissions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(calls.filter(c => c.path.startsWith('/api/agents/b1'))).toEqual([]);
  });

  it("closes the orchestrator's window for a person who does not open him, without asking the server", async () => {
    const calls = mockApi({});
    render(<Windows org={{ ...DEV_ORG, orchestrator: { ...DEV_ORG.orchestrator!, opens: false } }} id="orchestrator" />);
    await closed();
    expect(screen.queryByRole('heading', { name: 'Insufficient permissions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(calls.filter(c => c.path.startsWith('/api/agents/'))).toEqual([]);
  });

  it('shows a network failure without rendering an unchecked agent window', async () => {
    mockApi({ 'GET /api/agents/b1': [0, { error: { code: 'network', message: '' } }] });
    render(<Windows />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Hornhoof cannot reach its server');
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it.each([
    ['no department is selected', { deptId: null }, false],
    ['the department is there, whoever the person is: everyone sees the whole company', {}, false],
    ['the department is absent', { deptId: 'closed' }, true],
    ['the organization is still loading', { org: null }, false],
    ['the organization read is denied', { org: null, orgFailure: new ApiFailure(403, 'forbidden', 'Hidden') }, true],
    ['the organization is absent on the server', { org: null, orgFailure: new ApiFailure(404, 'not_found', 'Hidden') }, true],
  ])('decides a missing department when %s', (_name, change, expected) => {
    const input: Parameters<typeof departmentIsMissing>[0] = { deptId: 'd2', org: DEV_ORG, orgFailure: null, ...change };
    expect(departmentIsMissing(input)).toBe(expected);
  });

  it('removes waiting relationships to hidden agents', () => {
    const full = TREE_ORG.departments.find(d => d.id === 'd2')!;
    const department = { ...full, employees: full.employees.filter(e => e.id === 'b1') };
    const own = DEV_TREE.lines[0]!, hidden = DEV_TREE.lines[1]!;
    const waiting = [own, hidden].map(line => ({ agent: line.agent, waitsForAgent: line.agent, from: '2026-10-30T09:00:00.000Z', kind: 'stall' as const, taskId: line.taskId, number: line.number, title: line.title }));
    expect(visibleDepartmentTree({ ...DEV_TREE, waiting }, department).waiting).toEqual([waiting[0]]);
  });
});
