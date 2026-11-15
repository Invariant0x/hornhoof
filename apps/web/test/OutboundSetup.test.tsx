import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { DepartmentMessaging } from '../src/ui/OutboundSetup';
import { mockApi } from './api-mock';

/* A department's own outbound setup as the people who run it meet it: channels with their accounts and limits, the
   catalog with what to publish or take back, and the log of who did what on whose word. */

const DEPT = 'd-mkt';
const Q = `department=${DEPT}`;
const POLICY = {
  timezone: 'Europe/Berlin', accountDailyLimit: 40, domainDailyLimit: 200, autoSend: true,
  sampling: { matureAfter: 20, firstPerSegment: 1, firstPerAuthor: 3, everyNth: 10 },
  circuit: { windowHours: 24, minimumSample: 20, maxComplaints: 1, maxRefusals: 3, maxBounces: 5 },
};
const CHANNEL = {
  id: 'ch1', departmentId: DEPT, productId: null, name: 'Spring letters', adapter: 'smtp', purpose: 'first_contact', audience: 'direct', status: 'new', generation: 1, stoppedReason: null, stoppedAt: null,
  canManage: true, policy: { revision: 2, value: POLICY },
  accounts: [{ id: 'ac1', label: 'Spring', senderDomain: 'mkt.example', status: 'active', configGeneration: 1, available: false, author: { agentId: 'a-max', name: 'Max', generation: 1 } }],
};
const BARE = { ...CHANNEL, id: 'ch2', name: 'News', policy: null, accounts: [] };
const revision = (id: string, n: number, status: string, extra: object = {}) => ({
  id, revision: n, status, value: {}, summary: 'Spring', validFrom: '2026-01-01T00:00:00.000Z', validUntil: null, createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: { kind: 'agent', id: 'a-max', name: 'Max' }, publishedBy: null, publishedVia: null, publishedAt: null, revokedAt: null, ...extra,
});
const CATALOG = {
  departmentId: DEPT,
  entries: [
    { entryId: 'e1', kind: 'template', locale: 'en', productId: null, channel: null, current: 1, revisions: [revision('r2', 2, 'proposed'), revision('r1', 1, 'published', { publishedBy: { id: 'p-mona', name: 'Mona' }, publishedVia: { id: 'a-mia', name: 'Mia' } })] },
  ],
};
const LOG = {
  departmentId: DEPT,
  entries: [
    { id: 'l2', kind: 'auto_send_on', channel: { id: 'ch1', name: 'Spring letters' }, subjectId: null, detail: {}, person: { id: 'p-mona', name: 'Mona' }, agent: { id: 'a-mia', name: 'Mia' }, at: '2026-01-02T10:00:00.000Z' },
    { id: 'l1', kind: 'account_set_up', channel: { id: 'ch1', name: 'Spring letters' }, subjectId: null, detail: {}, person: { id: 'p-mona', name: 'Mona' }, agent: null, at: '2026-01-02T09:00:00.000Z' },
  ],
};
const overview = (channels: object[], runs = true) => ({ channels, messages: [], escalations: [], approvals: [], departments: runs ? [{ id: DEPT, name: 'Marketing', templateKey: null }] : [] });
const routes = (channels: object[] = [CHANNEL, BARE]) => ({
  [`GET /api/outbound?${Q}`]: [200, overview(channels)] as [number, unknown],
  [`GET /api/outbound/catalog?${Q}`]: [200, CATALOG] as [number, unknown],
  [`GET /api/outbound/setup-log?${Q}`]: [200, LOG] as [number, unknown],
});

const show = (language: 'en' | 'ru' = 'en') => {
  localStorage.setItem('hh-lang', language);
  return render(<LanguageProvider><DepartmentMessaging departmentId={DEPT} title="External messaging" /></LanguageProvider>);
};

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('a department\'s own outbound setup', () => {
  it('shows each channel\'s limits, sending without a yes and who writes from each account, and says what a channel lacks', async () => {
    mockApi(routes());
    show();
    const spring = (await screen.findByRole('heading', { name: 'Spring letters' })).closest('.imp') as HTMLElement;
    expect(spring).toHaveTextContent('up to 40 a day per account, 200 per domain · sends without a yes to each message');
    expect(spring).toHaveTextContent('Spring (mkt.example) · works · Max writes from it');
    const news = screen.getByRole('heading', { name: 'News' }).closest('.imp') as HTMLElement;
    expect(news).toHaveTextContent('No limits yet: nothing goes until they are set');
    expect(news).toHaveTextContent('No working account');
    expect(within(news).getByRole('button', { name: 'Set limits and sending' })).toBeInTheDocument();
  });

  it('publishes a proposed revision and takes back a published one, naming who published it on whose word', async () => {
    const calls = mockApi({ ...routes(), 'POST /api/outbound/catalog/r2/publish': [200, { id: 'r2', status: 'published' }], 'POST /api/outbound/catalog/r1/revoke': [200, { id: 'r1', status: 'revoked' }] });
    const user = userEvent.setup();
    show();
    const catalog = (await screen.findByRole('heading', { name: 'Department catalog' })).closest('section') as HTMLElement;
    expect(catalog).toHaveTextContent('Template: Spring');
    expect(catalog).toHaveTextContent('Messages use revision 1');
    expect(catalog).toHaveTextContent('by Mia on the word of Mona');
    await user.click(within(catalog).getByRole('button', { name: 'Publish' }));
    await user.click(within(catalog).getByRole('button', { name: 'Take back' }));
    await waitFor(() => expect(calls.filter(c => c.method === 'POST').map(c => c.path)).toEqual(['/api/outbound/catalog/r2/publish', '/api/outbound/catalog/r1/revoke']));
    expect(calls.filter(c => c.path === `/api/outbound/catalog?${Q}`).length).toBeGreaterThan(1);
  });

  it('connects a mail account once: its password goes in the request and is gone from the form', async () => {
    const calls = mockApi({ ...routes([BARE]), 'POST /api/outbound/accounts': [200, { accountId: 'ac9' }] });
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Connect a mail account' }));
    const form = screen.getByRole('form', { name: 'Connect a mail account' });
    const box = (label: string) => within(form).getByLabelText(label);
    await user.type(box('Account name'), 'News');
    await user.type(box('Mail server'), 'smtp.mkt.example');
    await user.type(box('Sign-in name'), 'news@mkt.example');
    await user.type(box('Password'), 'synthetic-pass');
    await user.type(box('Sender address'), 'news@mkt.example');
    await user.click(within(form).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(calls.find(c => c.method === 'POST')?.body).toEqual({
      channelId: 'ch2', label: 'News', config: { host: 'smtp.mkt.example', port: 465, security: 'tls', username: 'news@mkt.example', password: 'synthetic-pass', from: 'news@mkt.example' },
    }));
    expect(screen.queryByDisplayValue('synthetic-pass')).toBeNull();
  });

  it('sets limits with sending without a yes, keeping every number of the policy in place', async () => {
    const calls = mockApi({ ...routes([{ ...CHANNEL, policy: { revision: 2, value: { ...POLICY, autoSend: false } } }]), 'POST /api/outbound/channels/ch1/policies': [200, { revision: 3 }] });
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Change limits and sending' }));
    const form = screen.getByRole('form', { name: 'Limits and sending' });
    const perAccount = within(form).getByLabelText('Messages a day from one account');
    await user.clear(perAccount);
    await user.type(perAccount, '25');
    await user.click(within(form).getByRole('checkbox'));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find(c => c.method === 'POST')?.body).toEqual({ ...POLICY, accountDailyLimit: 25, autoSend: true }));
  });

  it('makes a new channel for the department', async () => {
    const calls = mockApi({ ...routes([]), 'POST /api/outbound/channels': [200, { channelId: 'ch3' }] });
    const user = userEvent.setup();
    show();
    expect(await screen.findByText(/This department has no channel yet/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New channel' }));
    const form = screen.getByRole('form', { name: 'New channel' });
    await user.type(within(form).getByLabelText('Channel name'), 'Letters');
    await user.type(within(form).getByLabelText('What contacts agree to'), 'first_contact');
    await user.click(within(form).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(calls.find(c => c.method === 'POST')?.body).toEqual({ departmentId: DEPT, name: 'Letters', adapter: 'smtp', purpose: 'first_contact', audience: 'direct' }));
  });

  it('shows the setup log with who did each step and through whom', async () => {
    mockApi(routes());
    show();
    const log = (await screen.findByRole('heading', { name: 'Setup log' })).closest('section') as HTMLElement;
    const lines = within(log).getAllByRole('listitem').map(li => li.textContent);
    expect(lines[0]).toContain('Sending without a yes turned on · Spring letters');
    expect(lines[0]).toContain('by Mia on the word of Mona');
    expect(lines[1]).toContain('Account connected');
    expect(lines[1]).toContain('by Mona');
  });

  it('shows nothing to someone who does not run the department, and reads neither its catalog nor its log', async () => {
    const calls = mockApi({ [`GET /api/outbound?${Q}`]: [200, overview([CHANNEL], false)] });
    const { container } = show();
    await waitFor(() => expect(calls.some(c => c.path === `/api/outbound?${Q}`)).toBe(true));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(calls.map(c => c.path)).not.toContain(`/api/outbound/catalog?${Q}`);
  });

  it('speaks Russian', async () => {
    mockApi(routes());
    show('ru');
    expect(await screen.findByRole('heading', { name: 'Каталог отдела' })).toBeInTheDocument();
    expect(screen.getByText(/отправляет без одобрения каждого письма/)).toBeInTheDocument();
    expect(screen.getAllByText(/решение: Mona, выполнил агент Mia/).length).toBeGreaterThan(0);
  });
});
