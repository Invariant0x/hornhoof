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
  return render(<LanguageProvider><DepartmentMessaging departmentId={DEPT} /></LanguageProvider>);
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
    expect(within(spring).getByText('new')).toHaveClass('status', 'invited');
    expect(within(spring).getByText('Mail (SMTP) · to contacts who agreed')).toBeInTheDocument();
    expect(within(spring).getByText('up to 40 a day per account, 200 per domain · sends without a yes to each message')).toBeInTheDocument();
    const account = within(spring).getByRole('listitem');
    expect(within(account).getByText('Spring')).toBeInTheDocument();
    expect(within(account).getByText('works')).toHaveClass('status', 'active');
    expect(account).toHaveTextContent('mkt.example · Max writes from it');
    expect(within(spring).getByRole('button', { name: 'Stop the channel' })).toHaveClass('danger');
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
    expect(within(catalog).getByText('proposed')).toHaveClass('status', 'invited');
    expect(within(catalog).getByText('published')).toHaveClass('status', 'active');
    expect(within(catalog).getByRole('button', { name: 'Publish' })).not.toHaveClass('danger');
    expect(within(catalog).getByRole('button', { name: 'Take back' })).toHaveClass('danger');
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

  it('adds a test address to a channel with the consent its purpose asks for, through the server\'s own consent check', async () => {
    const calls = mockApi({ ...routes(), 'POST /api/outbound/contacts': [200, { contactId: 'k1', permissionId: 'pm1' }] });
    const user = userEvent.setup();
    show();
    const spring = (await screen.findByRole('heading', { name: 'Spring letters' })).closest('.imp') as HTMLElement;
    await user.click(within(spring).getByRole('button', { name: 'Add an address' }));
    const form = within(spring).getByRole('form', { name: 'Add an address' });
    await user.type(within(form).getByLabelText('Email address'), 'team.test@mkt.example');
    await user.type(within(form).getByLabelText('Where they agreed'), 'Test address of our team');
    await user.type(within(form).getByLabelText('Proof of their consent'), 'My own address, to try the letters');
    const agreed = within(form).getByRole('checkbox', { name: /This person agreed to get messages of this channel/ });
    expect(agreed.closest('label')).toHaveTextContent('Purpose: first_contact');
    await user.click(agreed);
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(calls.filter(c => c.method === 'POST').map(c => [c.path, c.body])).toEqual([
      ['/api/outbound/contacts', { channelId: 'ch1', kind: 'email', address: 'team.test@mkt.example', source: 'Test address of our team', evidence: 'My own address, to try the letters' }],
    ]));
    expect(await within(spring).findByRole('status')).toHaveTextContent('team.test@mkt.example can get messages of this channel now.');
    expect(within(spring).queryByRole('form', { name: 'Add an address' })).toBeNull();
  });

  it('keeps an address that is not one, says so at its field and puts the focus there, before and after the server', async () => {
    const calls = mockApi({ ...routes(), 'POST /api/outbound/contacts': [400, { error: { code: 'validation', message: 'This is not one address.', reason: 'outbound_invalid' } }] });
    const user = userEvent.setup();
    show();
    const spring = (await screen.findByRole('heading', { name: 'Spring letters' })).closest('.imp') as HTMLElement;
    await user.click(within(spring).getByRole('button', { name: 'Add an address' }));
    const form = within(spring).getByRole('form', { name: 'Add an address' });
    const address = within(form).getByLabelText('Email address');
    await user.type(address, 'team test');
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    expect(address).toHaveAttribute('aria-invalid', 'true');
    expect(address).toHaveAccessibleDescription('This is not an email address. Check it and try again.');
    expect(address).toHaveFocus();
    expect(within(form).getByLabelText('Where they agreed')).toHaveAccessibleDescription(/Say where they agreed/);
    expect(within(form).getByRole('checkbox')).toHaveAccessibleDescription('Tick this only once the person agreed.');
    expect(calls.filter(c => c.method === 'POST')).toEqual([]);

    await user.clear(address);
    await user.type(address, 'team@mkt.example');
    await user.type(within(form).getByLabelText('Where they agreed'), 'Signup form');
    await user.type(within(form).getByLabelText('Proof of their consent'), 'Form entry 12');
    await user.click(within(form).getByRole('checkbox'));
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(address).toHaveAccessibleDescription('This is not an email address. Check it and try again.'));
    expect(address).toHaveFocus();
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
  });

  it('says so when the address asked not to be written to, and takes no address for a public channel', async () => {
    mockApi({ ...routes([CHANNEL, { ...BARE, audience: 'public' }]), 'POST /api/outbound/contacts': [409, { error: { code: 'conflict', message: 'This contact asked not to be written to.', reason: 'outbound_conflict', details: { reasonCodes: ['contact_suppressed'] } } }] });
    const user = userEvent.setup();
    show();
    const news = (await screen.findByRole('heading', { name: 'News' })).closest('.imp') as HTMLElement;
    expect(within(news).queryByRole('button', { name: 'Add an address' })).toBeNull();
    const spring = screen.getByRole('heading', { name: 'Spring letters' }).closest('.imp') as HTMLElement;
    await user.click(within(spring).getByRole('button', { name: 'Add an address' }));
    const form = within(spring).getByRole('form', { name: 'Add an address' });
    await user.type(within(form).getByLabelText('Email address'), 'gone@shop.example');
    await user.type(within(form).getByLabelText('Where they agreed'), 'Signup form');
    await user.type(within(form).getByLabelText('Proof of their consent'), 'Form entry 13');
    await user.click(within(form).getByRole('checkbox'));
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('This person asked not to get messages. Their address cannot be added again.');
  });

  it('takes an address without spaces for a webhook channel to contacts, and shows any other refusal above the buttons', async () => {
    const hook = { ...BARE, id: 'ch3', name: 'Chat', adapter: 'webhook' };
    const calls = mockApi({ ...routes([hook]), 'POST /api/outbound/contacts': [500, { error: { code: 'internal', message: 'The database did not answer.' } }] });
    const user = userEvent.setup();
    show();
    const chat = (await screen.findByRole('heading', { name: 'Chat' })).closest('.imp') as HTMLElement;
    await user.click(within(chat).getByRole('button', { name: 'Add an address' }));
    const form = within(chat).getByRole('form', { name: 'Add an address' });
    const address = within(form).getByLabelText('Address in the channel');
    expect(address).toHaveAttribute('type', 'text');
    await user.type(address, 'max test');
    await user.type(within(form).getByLabelText('Where they agreed'), 'Chat of the shop');
    await user.type(within(form).getByLabelText('Proof of their consent'), 'Wrote to us first');
    await user.click(within(form).getByRole('checkbox'));
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    expect(address).toHaveAccessibleDescription('An address here has no spaces. Check it and try again.');
    expect(address).toHaveFocus();
    await user.clear(address);
    await user.type(address, '@max_test');
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('The database did not answer.');
    expect(calls.filter(c => c.method === 'POST').map(c => c.body)).toEqual([{ channelId: 'ch3', kind: 'direct', address: '@max_test', source: 'Chat of the shop', evidence: 'Wrote to us first' }]);
  });

  it('says so when the address was already on the channel\'s list', async () => {
    mockApi({ ...routes(), 'POST /api/outbound/contacts': [200, { contactId: 'k1', permissionId: null }] });
    const user = userEvent.setup();
    show();
    const spring = (await screen.findByRole('heading', { name: 'Spring letters' })).closest('.imp') as HTMLElement;
    await user.click(within(spring).getByRole('button', { name: 'Add an address' }));
    const form = within(spring).getByRole('form', { name: 'Add an address' });
    await user.type(within(form).getByLabelText('Email address'), 'shop1@shop.example');
    await user.type(within(form).getByLabelText('Where they agreed'), 'Signup form');
    await user.type(within(form).getByLabelText('Proof of their consent'), 'Form entry 1');
    await user.click(within(form).getByRole('checkbox'));
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    expect(await within(spring).findByRole('status')).toHaveTextContent('shop1@shop.example was already on the list of this channel.');
  });

  it('shows the setup log with who did each step and through whom', async () => {
    mockApi(routes());
    show();
    const log = (await screen.findByRole('heading', { name: 'Setup log' })).closest('section') as HTMLElement;
    const [first, second] = within(log).getAllByRole('listitem');
    expect(within(first!).getByText('Sending without a yes turned on')).toBeInTheDocument();
    expect(within(first!).getByText('Spring letters')).toBeInTheDocument();
    expect(first).toHaveTextContent('by Mia on the word of Mona');
    expect(within(second!).getByText('Account connected')).toBeInTheDocument();
    expect(second).toHaveTextContent('by Mona');
    /* A dot holds to the piece before it, so that no line of the log begins with one. */
    expect(log.textContent).not.toMatch(/(^|[ \n])·/);
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
