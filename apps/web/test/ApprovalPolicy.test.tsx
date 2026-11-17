import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { ApprovalPolicyView, WaitingRequest } from '../src/types';
import { ApprovalPolicy } from '../src/ui/ApprovalPolicy';
import { DecidedByNote } from '../src/ui/DecidedBy';
import { DepartmentMessaging } from '../src/ui/OutboundSetup';
import { Requests } from '../src/ui/Requests';
import { mockApi } from './api-mock';
import { decl } from './css';

const t = en.dept.approvals;
const CHANNELS = ['message', 'price', 'publication', 'commit', 'spend', 'other'] as const;
const every = CHANNELS.map(channel => ({ channel, mode: 'every' as const }));
const view = (extra: Partial<ApprovalPolicyView> = {}): ApprovalPolicyView => ({
  departmentId: 'd1',
  owner: null,
  canSetOwner: false,
  canChangePolicy: false,
  candidates: [],
  rules: every,
  ...extra,
});
const POLICY = 'GET /api/departments/d1/approval-policy';
const ceoView = (extra: Partial<ApprovalPolicyView> = {}) => view({ canSetOwner: true, canChangePolicy: true, candidates: [{ id: 'p2', name: 'Dana', title: 'COO' }, { id: 'p3', name: 'Wes', title: '' }], ...extra });
const rowOf = (channel: keyof typeof t.channels) => within(screen.getByRole('group', { name: t.channels[channel] }));

describe('ApprovalPolicy', () => {
  it('says the CEO decides while there is no owner, and offers the CEO those who may own it', async () => {
    mockApi({ [POLICY]: [200, ceoView()] });
    render(<ApprovalPolicy departmentId="d1" />);
    const pick = (await screen.findByRole('combobox', { name: t.owner })) as HTMLSelectElement;
    expect(pick.value).toBe('');
    expect(within(pick).getAllByRole('option').map(o => o.textContent)).toEqual([t.ownerCeo, 'Dana, COO', 'Wes']);
    expect(screen.getByText(t.ownerHint)).toBeInTheDocument();
  });

  it('names the state of autonomous release in a word in both languages', () => {
    expect([en.dept.approvals.autonomousReleaseWord(true), en.dept.approvals.autonomousReleaseWord(false)]).toEqual(['on', 'off']);
    expect([ru.dept.approvals.autonomousReleaseWord(true), ru.dept.approvals.autonomousReleaseWord(false)]).toEqual(['включен', 'выключен']);
  });

  it('says in both languages that everyone given the department runs it too, the owner only coming first with its approvals', () => {
    expect(en.dept.approvals.ownerHint).toBe('The owner gets this department\'s approvals and decisions first. Everyone given the department runs it in full as well: hires and removes its employees, changes its sub-units and repository and answers its approvals.');
    expect(ru.dept.approvals.ownerHint).toBe('Хозяину отдела первым приходят его одобрения и решения. Каждый, кому дан отдел, тоже управляет им полностью: нанимает и убирает сотрудников, меняет подотделы и репозиторий и отвечает на одобрения.');
  });

  it('names the owner the CEO picks through the route, and shows them', async () => {
    const calls = mockApi({ [POLICY]: [200, ceoView()], 'PUT /api/departments/d1/owner': [200, { ownerPersonId: 'p2' }] });
    render(<ApprovalPolicy departmentId="d1" />);
    fireEvent.change(await screen.findByRole('combobox', { name: t.owner }), { target: { value: 'p2' } });
    await waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ personId: 'p2' }));
  });

  it('takes the owner away with the empty choice', async () => {
    const calls = mockApi({ [POLICY]: [200, ceoView({ owner: { id: 'p2', name: 'Dana' } })], 'PUT /api/departments/d1/owner': [200, { ownerPersonId: null }] });
    render(<ApprovalPolicy departmentId="d1" />);
    const pick = (await screen.findByRole('combobox', { name: t.owner })) as HTMLSelectElement;
    expect(pick.value).toBe('p2');
    fireEvent.change(pick, { target: { value: '' } });
    await waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ personId: null }));
  });

  it('tells the CEO what to do when nobody may be named yet', async () => {
    mockApi({ [POLICY]: [200, ceoView({ candidates: [] })] });
    render(<ApprovalPolicy departmentId="d1" />);
    expect(await screen.findByText(t.noCandidates)).toBeInTheDocument();
  });

  it('shows the server\'s refusal of an owner in place, and the choice goes back', async () => {
    mockApi({ [POLICY]: [200, ceoView()], 'PUT /api/departments/d1/owner': [400, { error: { code: 'validation', message: 'Only an active person with access to this department can own it.', reason: 'owner_no_access' } }] });
    render(<ApprovalPolicy departmentId="d1" />);
    const pick = (await screen.findByRole('combobox', { name: t.owner })) as HTMLSelectElement;
    fireEvent.change(pick, { target: { value: 'p2' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(en.errors.owner_no_access);
    expect(pick.value).toBe('');
  });

  it('gives the owner the rules to change and not the owner to change', async () => {
    mockApi({ [POLICY]: [200, view({ owner: { id: 'p2', name: 'Dana' }, canChangePolicy: true })] });
    render(<ApprovalPolicy departmentId="d1" />);
    expect(await screen.findByText(t.ownerIs('Dana'))).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: t.owner })).not.toBeInTheDocument();
    expect(rowOf('spend').getByRole('combobox', { name: t.mode })).toBeEnabled();
  });

  it('shows someone with access the rules in words, with nothing to change', async () => {
    mockApi({ [POLICY]: [200, view({ rules: [{ channel: 'spend', mode: 'within_limits', limit: 100, unit: 'USD' }, { channel: 'message', mode: 'new_kinds' }, { channel: 'price', mode: 'every' }] })] });
    render(<ApprovalPolicy departmentId="d1" />);
    expect(await screen.findByText(t.ownerNone)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(rowOf('spend').getByText(t.limitIs(100, 'USD'))).toBeInTheDocument();
    expect(rowOf('message').getByText(t.readModes.new_kinds)).toBeInTheDocument();
    expect(rowOf('price').getByText(t.readModes.every)).toBeInTheDocument();
    /* "To me" would be wrong here: the approval does not go to the person reading. */
    expect(screen.queryByText(t.modes.every)).not.toBeInTheDocument();
  });

  it('says "to me" to the one the approvals go to, and "to the owner" to a CEO looking at someone else\'s department', async () => {
    const everyOf = (view: ApprovalPolicyView) => {
      mockApi({ [POLICY]: [200, view] });
      return render(<ApprovalPolicy departmentId="d1" />);
    };
    const words = (r: ReturnType<typeof everyOf>) => within(r.container).findAllByRole('option', { name: t.modes.every });
    const own = everyOf(view({ owner: { id: 'p2', name: 'Dana' }, canChangePolicy: true }));
    expect((await words(own)).length).toBeGreaterThan(0);
    own.unmount();
    const noOwner = everyOf(ceoView());
    expect((await words(noOwner)).length).toBeGreaterThan(0);
    noOwner.unmount();
    const someone = everyOf(ceoView({ owner: { id: 'p2', name: 'Dana' } }));
    expect((await within(someone.container).findAllByRole('option', { name: t.everyToOwner })).length).toBeGreaterThan(0);
    expect(within(someone.container).queryByRole('option', { name: t.modes.every })).not.toBeInTheDocument();
  });

  it('saves a mode without a limit at once', async () => {
    const calls = mockApi({ [POLICY]: [200, ceoView()], 'PUT /api/departments/d1/approval-policy/message': [200, ceoView()] });
    render(<ApprovalPolicy departmentId="d1" />);
    await screen.findByRole('combobox', { name: t.owner });
    fireEvent.change(rowOf('message').getByRole('combobox', { name: t.mode }), { target: { value: 'new_kinds' } });
    await waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ mode: 'new_kinds' }));
  });

  it('asks for a limit before it saves the mode of limits, and sends a number', async () => {
    const calls = mockApi({ [POLICY]: [200, ceoView()], 'PUT /api/departments/d1/approval-policy/spend': [200, ceoView({ rules: [{ channel: 'spend', mode: 'within_limits', limit: 250.5, unit: 'USD' }] })] });
    render(<ApprovalPolicy departmentId="d1" />);
    await screen.findByRole('combobox', { name: t.owner });
    const row = rowOf('spend');
    fireEvent.change(row.getByRole('combobox', { name: t.mode }), { target: { value: 'within_limits' } });
    expect(calls.filter(c => c.method === 'PUT')).toEqual([]);
    const save = row.getByRole('button', { name: en.common.save });
    expect(save).toBeDisabled();
    fireEvent.change(row.getByRole('spinbutton', { name: t.limit }), { target: { value: '250.5' } });
    fireEvent.change(row.getByRole('textbox', { name: t.unit }), { target: { value: ' USD ' } });
    fireEvent.click(save);
    await waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ mode: 'within_limits', limit: 250.5, unit: 'USD' }));
  });

  it('offers a stored limit to change, and leaves a mode of limits with no unit without one', async () => {
    const calls = mockApi({ [POLICY]: [200, ceoView({ rules: [{ channel: 'spend', mode: 'within_limits', limit: 100 }] })], 'PUT /api/departments/d1/approval-policy/spend': [200, ceoView()] });
    render(<ApprovalPolicy departmentId="d1" />);
    await screen.findByRole('combobox', { name: t.owner });
    const row = rowOf('spend');
    expect((row.getByRole('spinbutton', { name: t.limit }) as HTMLInputElement).value).toBe('100');
    fireEvent.change(row.getByRole('spinbutton', { name: t.limit }), { target: { value: '5' } });
    fireEvent.click(row.getByRole('button', { name: en.common.save }));
    await waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ mode: 'within_limits', limit: 5 }));
  });

  it('shows a refused rule on its own line', async () => {
    mockApi({ [POLICY]: [200, ceoView()], 'PUT /api/departments/d1/approval-policy/message': [403, { error: { code: 'forbidden', message: 'No.', reason: 'policy_not_allowed' } }] });
    render(<ApprovalPolicy departmentId="d1" />);
    await screen.findByRole('combobox', { name: t.owner });
    fireEvent.change(rowOf('message').getByRole('combobox', { name: t.mode }), { target: { value: 'new_kinds' } });
    expect(await rowOf('message').findByRole('alert')).toHaveTextContent(en.errors.policy_not_allowed);
    expect((rowOf('message').getByRole('combobox', { name: t.mode }) as HTMLSelectElement).value).toBe('every');
  });

  it('says it is loading, and says so when it cannot load', async () => {
    mockApi({ [POLICY]: [403, { error: { code: 'forbidden', message: 'No.' } }] });
    render(<ApprovalPolicy departmentId="d1" />);
    expect(screen.getByText(en.common.loading)).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('loads again when the owner changes elsewhere', async () => {
    const calls = mockApi({ [POLICY]: [200, view()] });
    const { rerender } = render(<ApprovalPolicy departmentId="d1" ownerPersonId={null} />);
    await screen.findByText(t.ownerNone);
    const before = calls.length;
    rerender(<ApprovalPolicy departmentId="d1" ownerPersonId="p2" />);
    await waitFor(() => expect(calls.length).toBe(before + 1));
  });

  it('draws each channel fieldset without a browser frame through the shared field-group rule used in outbound setup', async () => {
    mockApi({
      [POLICY]: [200, ceoView()],
      'GET /api/outbound?department=d1': [
        200,
        {
          channels: [{ id: 'c1', departmentId: 'd1', name: 'Mail', adapter: 'smtp', purpose: 'first_contact', audience: 'direct', status: 'new', canManage: true, policy: null, accounts: [] }],
          messages: [], escalations: [], approvals: [], departments: [{ id: 'd1', name: 'Development', templateKey: null }],
        },
      ],
      'GET /api/outbound/catalog?department=d1': [200, { entries: [] }],
      'GET /api/outbound/setup-log?department=d1': [200, { entries: [] }],
      'GET /api/outbound/contacts?department=d1': [200, { contacts: [] }],
    });
    const { container } = render(
      <>
        <ApprovalPolicy departmentId="d1" />
        <DepartmentMessaging departmentId="d1" />
      </>,
    );
    await screen.findByRole('combobox', { name: t.owner });
    fireEvent.click(await screen.findByRole('button', { name: 'Set limits and sending' }));

    const approvalGroups = [...container.querySelectorAll('.appr-rules > fieldset')];
    const outboundGroups = [...container.querySelectorAll('.outbound-numbers')];
    expect(approvalGroups).toHaveLength(CHANNELS.length);
    expect(outboundGroups).toHaveLength(2);
    for (const group of [...approvalGroups, ...outboundGroups]) {
      expect(group).toHaveClass('field-group');
      expect(group.querySelector(':scope > legend + .field-group-body')).not.toBeNull();
    }

    expect(decl('.field-group', 'border')).toBe('0');
    expect(decl('.field-group', 'padding')).toBe('0');
    expect(decl('.field-group > legend', 'float')).toBe('inline-start');
    expect(decl('.field-group > legend', 'inline-size')).toBe('100%');
    expect(decl('.field-group > legend', 'font-family')).toBe('var(--f-display)');
    expect(decl('.field-group-body', 'clear')).toBe('both');
    expect(decl('.field-group-body', 'padding-block-start')).toBe('4px');
    expect(decl('.appr-rule', 'border')).toBeUndefined();
    expect(decl('.outbound-numbers', 'border')).toBeUndefined();
  });
});

describe('an approval under a department\'s policy', () => {
  const asked = {
    id: 'r1', kind: 'approval', text: 'Buy ads for the launch.', commit: null, commitUrl: null, images: [], options: [], link: null, explained: null, explaining: false,
    at: '2026-11-05T10:00:00.000Z', agent: { id: 'a1', name: 'Bruno' }, task: { id: 't1', number: 7, title: 'Launch', department: null }, ownerPersonId: 'p2', canAnswer: true,
    decidedBy: { kind: 'owner_and_ceo', department: { id: 'd1', name: 'Marketing' } },
  } as WaitingRequest;
  const shared = { onChanged() {}, onOpenTask() {}, onOpenAgent() {}, placeName: () => '' };

  it('asks in words, with no commit to show, and sends the answer', async () => {
    const calls = mockApi({ 'POST /api/requests/r1': [200, { request: { id: 'r1', status: 'approved' } }] });
    const { container } = render(<Requests requests={[asked]} {...shared} />);
    expect(screen.getByText(en.tasks.asksApprovalOf('Bruno'))).toBeInTheDocument();
    expect(container.querySelector('.req-commit')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: en.tasks.approve }));
    await waitFor(() => expect(calls[0]?.body).toEqual({ approve: true }));
  });

  it('names the owner to someone who may not take it', () => {
    const { container } = render(<Requests requests={[{ ...asked, canAnswer: false }]} {...shared} />);
    expect(screen.getByText(en.tasks.decidedByOwner('Marketing'))).toBeInTheDocument();
    expect(container.querySelector('.req-commit')).toBeNull();
  });

  it('keeps the commit of an approval that names one', () => {
    const { container } = render(<Requests requests={[{ ...asked, commit: 'a'.repeat(40) }]} {...shared} />);
    expect(screen.getByText(en.tasks.asksApproval('Bruno'))).toBeInTheDocument();
    expect(container.querySelector('.req-commit')).toHaveTextContent('a'.repeat(40));
  });
});

describe('who takes an approval', () => {
  it('names the owner of the department', () => {
    render(<DecidedByNote by={{ kind: 'owner_and_ceo', department: { id: 'd1', name: 'Development' } }} />);
    expect(screen.getByText(en.tasks.decidedByOwner('Development'))).toBeInTheDocument();
  });
});

describe('the words', () => {
  it('has every channel and mode in both languages, in plain Russian with no letter yo and no long dash', () => {
    const r = ru.dept.approvals;
    expect(Object.keys(r.channels).sort()).toEqual([...CHANNELS].sort());
    expect(Object.keys(r.modes).sort()).toEqual(['every', 'new_kinds', 'within_limits']);
    expect(Object.keys(r.readModes).sort()).toEqual(['every', 'new_kinds']);
    expect(r.modes).toEqual({ every: 'Каждое мне', new_kinds: 'Только новые виды', within_limits: 'Без одобрения в пределах лимитов' });
    const words = JSON.stringify(r, (_k, v: unknown) => (typeof v === 'function' ? String((v as (a: string, b: string) => string)('a', 'b')) : v));
    expect(words).not.toMatch(/[\u0451\u0401\u2014]/);
    expect(en.dept.approvals).toHaveProperty('autonomousRelease');
    expect(ru.dept.approvals).toHaveProperty('autonomousRelease');
    expect(String((ru.dept.approvals as Record<string, unknown>).autonomousRelease)).toContain('Автономный выпуск');
  });

  it('lets the people who run the department toggle its autonomous release, the CEO too, and shows its journal', async () => {
    const entry = {
      id: 'ar1',
      taskId: 't1',
      taskNumber: 12,
      agentId: 'a1',
      agentName: 'Hana',
      commitSha: 'a'.repeat(40),
      baseCommitSha: '1'.repeat(40),
      testRunId: 'tr1',
      testRunNumber: 42,
      reviewerAgentId: 'a2',
      reviewerName: 'Rita',
      verdictStage: 'review',
      createdAt: '2026-11-14T12:00:00.000Z',
    };
    const calls = mockApi({
      [POLICY]: [200, ceoView({ autonomousRelease: false, canSetAutonomousRelease: true } as Partial<ApprovalPolicyView>)],
      'PUT /api/departments/d1/approval-policy/autonomous-release': [
        200,
        ceoView({ autonomousRelease: true, canSetAutonomousRelease: true, hasAutonomousReleases: true } as Partial<ApprovalPolicyView>),
      ],
      'GET /api/autonomous-releases?department=d1': [200, { entries: [entry] }],
    });
    const { unmount } = render(<ApprovalPolicy departmentId="d1" />);
    await screen.findByRole('combobox', { name: t.owner });
    const toggle = screen.getByRole('switch', { name: /autonomous release/i });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(calls.find(c => c.method === 'PUT' && c.path.endsWith('/autonomous-release'))?.body).toEqual({ enabled: true }),
    );
    expect(await screen.findByText(/Hana/)).toBeInTheDocument();
    expect(screen.getByText(/Rita/)).toBeInTheDocument();
    expect(screen.getByText(/#12/)).toBeInTheDocument();
    expect(screen.getByText(/42/)).toBeInTheDocument();
    unmount();

    /* Dana runs the department without being the CEO: the switch is hers, and she turns it off herself. */
    const hers = view({ owner: { id: 'p2', name: 'Dana' }, canChangePolicy: true, autonomousRelease: true, canSetAutonomousRelease: true } as Partial<ApprovalPolicyView>);
    const owner = mockApi({
      [POLICY]: [200, hers],
      'PUT /api/departments/d1/approval-policy/autonomous-release': [200, { ...hers, autonomousRelease: false }],
      'GET /api/autonomous-releases?department=d1': [200, { entries: [] }],
    });
    const second = render(<ApprovalPolicy departmentId="d1" />);
    await screen.findByText(t.ownerIs('Dana'));
    const own = screen.getByRole('switch', { name: /autonomous release/i });
    expect(own).toBeChecked();
    /* Its state is said in a word beside the box, not by the box alone. */
    const line = own.closest('label')!;
    expect(within(line).getByText(t.autonomousReleaseWord(true))).toBeInTheDocument();
    fireEvent.click(own);
    await waitFor(() => expect(owner.find(c => c.method === 'PUT' && c.path.endsWith('/autonomous-release'))?.body).toEqual({ enabled: false }));
    expect(await within(line).findByText(t.autonomousReleaseWord(false))).toBeInTheDocument();
    second.unmount();

    /* Someone who sees the department but does not run it reads its state, with no switch. */
    mockApi({
      [POLICY]: [200, view({ owner: { id: 'p2', name: 'Dana' }, autonomousRelease: true, canSetAutonomousRelease: false } as Partial<ApprovalPolicyView>)],
      'GET /api/autonomous-releases?department=d1': [200, { entries: [] }],
    });
    render(<ApprovalPolicy departmentId="d1" />);
    await screen.findByText(t.ownerIs('Dana'));
    expect(screen.queryByRole('switch', { name: /autonomous release/i })).not.toBeInTheDocument();
    expect(screen.getByText(t.autonomousReleaseState(true))).toBeInTheDocument();
  });
});
