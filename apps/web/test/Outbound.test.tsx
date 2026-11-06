import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { parseRoute, routePath } from '../src/routes';
import { Shell } from '../src/screens/Shell';
import type { WaitingRequest } from '../src/types';
import { Outbound } from '../src/ui/Outbound';
import { Requests } from '../src/ui/Requests';
import { decisions, ME, mockApi, ORG } from './api-mock';

const MSG_REQ_ID = '11111111-1111-4111-8111-111111111111';
const APP_REQ_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';

const SALES_DECIDED_BY = { kind: 'owner_and_ceo' as const, department: { id: 'd-sales', name: 'Sales' } };

const BOUND_MESSAGE = {
  kind: 'message' as const,
  requestId: MSG_REQ_ID,
  status: 'open',
  canAnswer: true,
  decidedBy: SALES_DECIDED_BY,
  channel: { id: 'ch1', name: 'Sales Mail', adapter: 'smtp' as const, purpose: 'first_contact', audience: 'direct' as const },
  account: { id: 'ac1', label: 'Sales Primary', senderDomain: 'mail.acme.example', bindingGeneration: 2 },
  messageId: '44444444-4444-4444-8444-444444444444',
  revision: 1,
  locale: 'en',
  contentDigest: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  policyDigest: '4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a',
  sourceRevisionsDigest: 'ef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d',
  rendered: {
    subject: 'Quarterly plan overview',
    body: 'Plan price: $29.00\nDetails: https://acme.example/pricing',
  },
  sources: [
    { kind: 'template', entryId: 'tpl-1', revision: 3, summary: 'Quarterly plan overview' },
    { kind: 'price', entryId: 'prc-1', revision: 2, summary: '29.00 USD' },
    { kind: 'link', entryId: 'lnk-1', revision: 1, summary: 'https://acme.example/pricing' },
  ],
};

const BOUND_APPROACH = {
  kind: 'approach' as const,
  requestId: APP_REQ_ID,
  status: 'open',
  canAnswer: false,
  decidedBy: SALES_DECIDED_BY,
  channel: { id: 'ch1', name: 'Sales Mail', adapter: 'smtp' as const, purpose: 'first_contact', audience: 'direct' as const },
  segment: { id: 'seg-1', revision: 1, name: 'Verified retail leads' },
  template: { id: 'tpl-1', revision: 3, locale: 'en', subject: 'Quarterly plan overview', preview: 'Plan price: [price]' },
  policyDigest: '4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a',
  sourceRevisionsDigest: 'ef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d',
  sources: [{ kind: 'template', entryId: 'tpl-1', revision: 3, summary: 'Quarterly plan overview' }],
};

const OVERVIEW = {
  channels: [
    {
      id: 'ch1',
      departmentId: 'd-sales',
      productId: null,
      name: 'Sales Mail',
      adapter: 'smtp' as const,
      purpose: 'first_contact',
      audience: 'direct' as const,
      status: 'active' as const,
      generation: 1,
      stoppedReason: null,
      stoppedAt: null,
      accounts: [{ id: 'ac1', label: 'Sales Primary', senderDomain: 'mail.acme.example', status: 'active' as const, configGeneration: 1, available: false }],
    },
  ],
  messages: [
    {
      id: '55555555-5555-4555-8555-555555555555',
      departmentId: 'd-sales',
      productId: null,
      taskId: TASK_ID,
      channelId: 'ch1',
      channelName: 'Sales Mail',
      accountId: 'ac1',
      accountLabel: 'Sales Primary',
      senderDomain: 'mail.acme.example',
      revision: 1,
      contentDigest: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      status: 'unknown' as const,
      reasonCodes: ['delivery_unknown' as const],
      scheduledAt: '2026-11-06T12:00:00.000Z',
      updatedAt: '2026-11-06T12:02:00.000Z',
      unknownRecovery: {
        attemptId: '66666666-6666-4666-8666-666666666666',
        safeCode: 'timeout',
        endedAt: '2026-11-06T12:02:00.000Z',
        quotaHeld: true as const,
        nextActionCode: 'check_receiver_before_resend' as const,
      },
    },
  ],
  escalations: [
    {
      ticketId: 'TKT-77',
      revision: 1,
      departmentId: 'd-sales',
      productId: null,
      status: 'escalated' as const,
      classId: 'refund_request',
      reasonCodes: ['requires_human' as const],
      requestId: MSG_REQ_ID,
      taskId: TASK_ID,
      ownerPersonId: 'p2',
      canAnswer: false,
      decidedBy: SALES_DECIDED_BY,
      createdAt: '2026-11-06T12:00:00.000Z',
    },
  ],
  approvals: [BOUND_MESSAGE, BOUND_APPROACH],
};

function inRussian(node: ReactNode) {
  localStorage.setItem('hh-lang', 'ru');
  try {
    return render(<LanguageProvider>{node}</LanguageProvider>);
  } finally {
    localStorage.removeItem('hh-lang');
  }
}

describe('Outbound screen, bound Requests snapshot, and routing (#447 T8-17)', () => {
  afterEach(() => {
    localStorage.removeItem('hh-lang');
    history.replaceState(null, '', '/');
  });

  it('parses and formats /outbound without altering top navigation tabs', async () => {
    expect(parseRoute('/outbound')).toEqual({ kind: 'outbound' });
    expect(routePath({ kind: 'outbound' })).toBe('/outbound');

    mockApi({
      'GET /api/org': [200, ORG],
      'GET /api/requests': [200, decisions([])],
      'GET /api/improvements': [200, { improvements: [] }],
      'GET /api/version': [200, { version: '0.7.0', commit: 'abcdef0' }],
      'GET /api/outbound': [200, OVERVIEW],
    });
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);

    const navButtons = within(screen.getByRole('navigation')).getAllByRole('button').map(b => b.textContent);
    expect(navButtons).toEqual(['Map', 'Tasks', 'People', 'Subscriptions', 'Machines']);

    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Outbound' }));
    expect(await screen.findByRole('heading', { name: 'Outbound' })).toBeInTheDocument();
  });

  it('renders exact bound approvals for owners vs read-only viewers, unknown delivery recovery, and escalations in English and Russian', async () => {
    const calls = mockApi({
      'GET /api/outbound': [200, OVERVIEW],
      [`POST /api/requests/${MSG_REQ_ID}`]: [200, { request: { id: MSG_REQ_ID, status: 'approved' } }],
    });
    const openedTasks: string[] = [];
    const user = userEvent.setup();
    const { unmount } = render(<Outbound onOpenTask={id => openedTasks.push(id)} />);

    expect(await screen.findByText('Quarterly plan overview')).toBeInTheDocument();
    expect(screen.getByText(/Plan price: \$29\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Do not resend automatically\. Quota and account remain held/)).toBeInTheDocument();
    expect(screen.getByText(/Ticket TKT-77/)).toBeInTheDocument();

    const articles = screen.getAllByRole('article');
    const msgCard = articles.find(el => el.textContent?.includes('Plan price: $29.00'))!;
    const approachCard = articles.find(el => el.textContent?.includes('Verified retail leads'))!;

    expect(within(msgCard).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(within(approachCard).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(within(approachCard).getByText('Decided by the owner of Sales, the CEO or the CEO delegate.')).toBeInTheDocument();

    await user.click(within(msgCard).getByRole('button', { name: 'Approve' }));
    await vi.waitFor(() =>
      expect(calls.some(c => c.method === 'POST' && c.path === `/api/requests/${MSG_REQ_ID}` && (c.body as { approve?: boolean })?.approve === true)).toBe(true),
    );

    await user.click(screen.getAllByRole('button', { name: 'Open task' })[0]!);
    expect(openedTasks).toEqual([TASK_ID]);
    unmount();

    mockApi({ 'GET /api/outbound': [200, OVERVIEW] });
    inRussian(<Outbound onOpenTask={() => {}} />);
    expect(await screen.findByRole('heading', { name: 'Исходящие' })).toBeInTheDocument();
    expect(screen.getByText(/Не отправляйте повторно вслепую/)).toBeInTheDocument();
    expect(screen.getAllByText('Принимает владелец отдела Sales, CEO или его заместитель.').length).toBeGreaterThanOrEqual(1);
  });

  it('embeds exact bound outbound snapshots inside Requests for both decision owners and read-only viewers', async () => {
    const waiting: WaitingRequest = {
      id: MSG_REQ_ID,
      kind: 'approval',
      text: 'Approve outbound message to verified retail lead',
      commit: null,
      commitUrl: null,
      images: [],
      options: [],
      link: null,
      explained: null,
      explaining: false,
      at: '2026-11-06T12:00:00.000Z',
      agent: { id: 'a1', name: 'Rita' },
      task: { id: TASK_ID, number: 42, title: 'Send verified updates', department: { id: 'd-sales', name: 'Sales' } },
      ownerPersonId: 'p2',
      canAnswer: false,
      decidedBy: SALES_DECIDED_BY,
    };

    mockApi({
      [`GET /api/requests/${MSG_REQ_ID}/outbound-approval`]: [200, { ...BOUND_MESSAGE, canAnswer: false }],
    });

    const { unmount } = render(
      <Requests
        requests={[waiting]}
        onChanged={() => {}}
        onOpenTask={() => {}}
        onOpenAgent={() => {}}
        placeName={p => p?.name ?? ''}
      />,
    );

    expect(await screen.findByText('Quarterly plan overview')).toBeInTheDocument();
    expect(screen.getByText(/Plan price: \$29\.00/)).toBeInTheDocument();
    expect(screen.getByText(/29\.00 USD/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByText('Decided by the owner of Sales, the CEO or the CEO delegate.')).toBeInTheDocument();
    unmount();

    mockApi({
      [`GET /api/requests/${MSG_REQ_ID}/outbound-approval`]: [200, BOUND_MESSAGE],
    });
    render(
      <Requests
        requests={[{ ...waiting, canAnswer: true }]}
        onChanged={() => {}}
        onOpenTask={() => {}}
        onOpenAgent={() => {}}
        placeName={p => p?.name ?? ''}
      />,
    );
    expect(await screen.findByText('Quarterly plan overview')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });
});
