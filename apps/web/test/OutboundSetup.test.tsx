import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { DepartmentMessaging } from '../src/ui/OutboundSetup';
import { mockApi } from './api-mock';
import { unisolated } from './bidi';
import { decl } from './css';

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
/* The addresses on the department's channels: one that agreed, added by Mona through Mia, and one whose consent was taken
   back; the news channel has none. */
const CONTACTS = {
  departmentId: DEPT,
  contacts: [
    { permissionId: 'pm1', channelId: 'ch1', kind: 'email', address: 'team.test@mkt.example', purpose: 'first_contact', source: 'Test address of our team', status: 'granted', grantedAt: '2026-01-02T10:00:00.000Z', revokedAt: null, doNotContact: false, addedBy: { person: { id: 'p-mona', name: 'Mona' }, agent: { id: 'a-mia', name: 'Mia' } } },
    { permissionId: 'pm0', channelId: 'ch1', kind: 'email', address: 'old.list@shop.example', purpose: 'first_contact', source: 'Signup form', status: 'revoked', grantedAt: '2026-01-01T09:00:00.000Z', revokedAt: '2026-01-01T12:00:00.000Z', doNotContact: false, addedBy: null },
  ],
};
const overview = (channels: object[], runs = true) => ({ channels, messages: [], escalations: [], approvals: [], departments: runs ? [{ id: DEPT, name: 'Marketing', templateKey: null }] : [] });
const routes = (channels: object[] = [CHANNEL, BARE]) => ({
  [`GET /api/outbound?${Q}`]: [200, overview(channels)] as [number, unknown],
  [`GET /api/outbound/catalog?${Q}`]: [200, CATALOG] as [number, unknown],
  [`GET /api/outbound/setup-log?${Q}`]: [200, LOG] as [number, unknown],
  [`GET /api/outbound/contacts?${Q}`]: [200, CONTACTS] as [number, unknown],
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
    const [account] = within(spring).getAllByRole('listitem');
    expect(within(account!).getByText('Spring')).toBeInTheDocument();
    expect(within(account!).getByText('works')).toHaveClass('status', 'active');
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
    expect(within(catalog).queryByRole('button', { name: 'Take back' })).toBeNull();
    await user.click(within(catalog).getByRole('button', { name: 'Show revision 1' }));
    expect(within(catalog).getByRole('button', { name: 'Publish' })).not.toHaveClass('danger');
    expect(within(catalog).getByRole('button', { name: 'Take back' })).toHaveClass('danger');
    await user.click(within(catalog).getByRole('button', { name: 'Publish' }));
    await user.click(within(catalog).getByRole('button', { name: 'Take back' }));
    await waitFor(() => expect(calls.filter(c => c.method === 'POST').map(c => [c.path, c.body])).toEqual([['/api/outbound/catalog/r2/publish', { revision: 2, newest: 2 }], ['/api/outbound/catalog/r1/revoke', { revision: 1, newest: 2 }]]));
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

  it('frames a field to correct in pink, with the focus ring outside it, by the rules every form shares, the tick of consent too', () => {
    const wrong = '.field :is(input, select, textarea)[aria-invalid="true"]';
    expect(decl(wrong, 'border-color')).toBe('var(--pink)');
    expect(decl(`${wrong}:is(:focus, :focus-visible)`, 'outline')).toBe('2px solid var(--cyan-ink)');
    expect(decl(`${wrong}:is(:focus, :focus-visible)`, 'box-shadow')).toBe('none');
    expect(decl('.check-card:has([aria-invalid="true"])', 'border-color')).toBe('var(--pink)');
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

  it('lists the addresses on each channel with their consent, purpose, when and by whom, and takes a consent back', async () => {
    let taken = false;
    const calls = mockApi({
      ...routes(),
      [`GET /api/outbound/contacts?${Q}`]: () => [200, { ...CONTACTS, contacts: CONTACTS.contacts.map(one => (taken && one.permissionId === 'pm1' ? { ...one, status: 'revoked', revokedAt: '2026-01-03T10:00:00.000Z' } : one)) }],
      'POST /api/outbound/permissions/pm1/revoke': () => {
        taken = true;
        return [200, { permissionId: 'pm1', status: 'revoked' }];
      },
    });
    const user = userEvent.setup();
    show();
    const spring = (await screen.findByRole('heading', { name: 'Spring letters' })).closest('.imp') as HTMLElement;
    const news = screen.getByRole('heading', { name: 'News' }).closest('.imp') as HTMLElement;
    /* The addresses are a block of their own after the channel's buttons, under a heading that counts those whose consent
       is in force; one taken back stays on the list, marked so (Design #1193, #1201). */
    const heading = within(spring).getByRole('heading', { name: 'Addresses with consent: 1' });
    const listed = within(spring).getByRole('list', { name: 'Addresses with consent: 1' });
    const channelButtons = within(spring).getByRole('button', { name: 'Stop the channel' }).parentElement!;
    expect(channelButtons.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(listed).toHaveClass('outbound-entries');
    const [agreed, takenBack] = within(listed).getAllByRole('listitem');
    expect(within(agreed!).getByText('team.test@mkt.example')).toBeInTheDocument();
    expect(agreed).toHaveTextContent('agreed');
    expect(agreed).toHaveTextContent('Purpose: first_contact · Test address of our team · 02/01/2026, 10:00 · by Mia on the word of Mona');
    expect(within(takenBack!).getByText('old.list@shop.example')).toBeInTheDocument();
    expect(takenBack).toHaveTextContent('consent taken back');
    expect(within(takenBack!).queryByRole('button')).toBeNull();
    expect(within(news).getByRole('heading', { name: 'Addresses with consent: 0' })).toBeInTheDocument();
    expect(within(news).getByText('No addresses yet')).toBeInTheDocument();
    expect(within(news).queryByRole('list', { name: /Addresses/ })).toBeNull();

    await user.click(within(agreed!).getByRole('button', { name: 'Take back consent' }));
    await waitFor(() => expect(calls.filter(c => c.method === 'POST').map(c => [c.path, c.body])).toEqual([['/api/outbound/permissions/pm1/revoke', {}]]));
    await waitFor(() => expect(calls.filter(c => c.path === `/api/outbound/contacts?${Q}`)).toHaveLength(2));
    expect(calls.filter(c => c.path === `/api/outbound/setup-log?${Q}`)).toHaveLength(2);
    expect(await within(spring).findByRole('heading', { name: 'Addresses with consent: 0' })).toBeInTheDocument();
    expect(within(agreed!).getByRole('status')).toHaveTextContent('team.test@mkt.example will not get messages of this channel any more.');
    expect(agreed).toHaveTextContent('consent taken back');
  });

  it('reads the list again once an address is added, and says so right under its entry', async () => {
    const added = { ...CONTACTS.contacts[0]!, permissionId: 'pm2', address: 'max.test@mkt.example', grantedAt: '2026-01-03T10:00:00.000Z' };
    let reads = 0;
    const calls = mockApi({
      ...routes(),
      [`GET /api/outbound/contacts?${Q}`]: () => [200, { ...CONTACTS, contacts: reads++ ? [added, ...CONTACTS.contacts] : CONTACTS.contacts }],
      'POST /api/outbound/contacts': [200, { contactId: 'k1', permissionId: 'pm2' }],
    });
    const user = userEvent.setup();
    show();
    const spring = (await screen.findByRole('heading', { name: 'Spring letters' })).closest('.imp') as HTMLElement;
    await user.click(within(spring).getByRole('button', { name: 'Add an address' }));
    const form = within(spring).getByRole('form', { name: 'Add an address' });
    await user.type(within(form).getByLabelText('Email address'), 'max.test@mkt.example');
    await user.type(within(form).getByLabelText('Where they agreed'), 'Test address of our team');
    await user.type(within(form).getByLabelText('Proof of their consent'), 'My own address');
    await user.click(within(form).getByRole('checkbox'));
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(calls.filter(c => c.path === `/api/outbound/contacts?${Q}`)).toHaveLength(2));
    const listed = await within(spring).findByRole('list', { name: 'Addresses with consent: 2' });
    const [first] = within(listed).getAllByRole('listitem');
    expect(within(first!).getByRole('status')).toHaveTextContent('max.test@mkt.example can get messages of this channel now.');
    expect(within(spring).getAllByRole('status')).toHaveLength(1);
  });

  /* What adding said is only for right after it: taking the consent back says so in its place (Design #1201, B1). */
  it('replaces what adding said with what taking back said, under the same entry', async () => {
    const added = { ...CONTACTS.contacts[0]!, permissionId: 'pm2', address: 'max.test@mkt.example', grantedAt: '2026-01-03T10:00:00.000Z' };
    let state: 'none' | 'granted' | 'revoked' = 'none';
    mockApi({
      ...routes(),
      [`GET /api/outbound/contacts?${Q}`]: () => [200, { ...CONTACTS, contacts: state === 'none' ? CONTACTS.contacts : [{ ...added, status: state }, ...CONTACTS.contacts] }],
      'POST /api/outbound/contacts': () => {
        state = 'granted';
        return [200, { contactId: 'k1', permissionId: 'pm2' }];
      },
      'POST /api/outbound/permissions/pm2/revoke': () => {
        state = 'revoked';
        return [200, { permissionId: 'pm2', status: 'revoked' }];
      },
    });
    const user = userEvent.setup();
    show();
    const spring = (await screen.findByRole('heading', { name: 'Spring letters' })).closest('.imp') as HTMLElement;
    await user.click(within(spring).getByRole('button', { name: 'Add an address' }));
    const form = within(spring).getByRole('form', { name: 'Add an address' });
    await user.type(within(form).getByLabelText('Email address'), 'max.test@mkt.example');
    await user.type(within(form).getByLabelText('Where they agreed'), 'Test address of our team');
    await user.type(within(form).getByLabelText('Proof of their consent'), 'My own address');
    await user.click(within(form).getByRole('checkbox'));
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    const line = (await within(spring).findByText('max.test@mkt.example', { selector: 'bdi' })).closest('li')!;
    expect(await within(line).findByRole('status')).toHaveTextContent('max.test@mkt.example can get messages of this channel now.');
    await user.click(within(line).getByRole('button', { name: 'Take back consent' }));
    await waitFor(() => expect(within(line).getByRole('status')).toHaveTextContent('max.test@mkt.example will not get messages of this channel any more.'));
    expect(within(spring).getAllByRole('status')).toHaveLength(1);
    expect(spring).not.toHaveTextContent('can get messages of this channel now');
  });

  it('says an address was already there right under its entry, however it was typed', async () => {
    mockApi({ ...routes(), 'POST /api/outbound/contacts': [200, { contactId: 'k1', permissionId: null }] });
    const user = userEvent.setup();
    show();
    const spring = (await screen.findByRole('heading', { name: 'Spring letters' })).closest('.imp') as HTMLElement;
    await user.click(within(spring).getByRole('button', { name: 'Add an address' }));
    const form = within(spring).getByRole('form', { name: 'Add an address' });
    await user.type(within(form).getByLabelText('Email address'), ' Team.Test@MKT.example');
    await user.type(within(form).getByLabelText('Where they agreed'), 'Test address of our team');
    await user.type(within(form).getByLabelText('Proof of their consent'), 'My own address');
    await user.click(within(form).getByRole('checkbox'));
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    const known = within(spring).getByRole('list', { name: 'Addresses with consent: 1' });
    const line = within(known).getByText('team.test@mkt.example').closest('li')!;
    expect(await within(line).findByRole('status')).toHaveTextContent('Team.Test@MKT.example was already on the list of this channel.');
  });

  it('names adding an address and taking back its consent in the setup log', async () => {
    const entries = [
      { id: 'l4', kind: 'consent_revoked', channel: { id: 'ch1', name: 'Spring letters' }, subjectId: 'pm1', detail: { kind: 'email' }, person: { id: 'p-mona', name: 'Mona' }, agent: null, at: '2026-01-03T10:00:00.000Z' },
      { id: 'l3', kind: 'contact_added', channel: { id: 'ch1', name: 'Spring letters' }, subjectId: 'pm1', detail: { kind: 'email' }, person: { id: 'p-mona', name: 'Mona' }, agent: null, at: '2026-01-03T09:00:00.000Z' },
    ];
    mockApi({ ...routes(), [`GET /api/outbound/setup-log?${Q}`]: [200, { departmentId: DEPT, entries }] });
    show();
    const log = (await screen.findByRole('heading', { name: 'Setup log' })).closest('section') as HTMLElement;
    expect(within(log).getAllByRole('listitem').map(li => li.querySelector('b')!.textContent)).toEqual(['Consent of an address taken back', 'Address added']);
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
    const listed = screen.getByRole('list', { name: 'Адреса с согласием: 1' });
    expect(screen.getByText('Адресов пока нет')).toBeInTheDocument();
    expect(within(listed).getAllByRole('listitem')[0]).toHaveTextContent('согласие есть');
    expect(within(listed).getByRole('button', { name: 'Отозвать согласие' })).toBeInTheDocument();
    expect(screen.getByText(/отправляет без одобрения каждого письма/)).toBeInTheDocument();
    expect(screen.getAllByText(/решение: Mona, выполнил агент Mia/).length).toBeGreaterThan(0);
  });
});

/* Nobody publishes blind: each revision of an entry shows what a message would say, the newest one at once, and what
   changed from the version messages use now. What is published is the version shown. */
describe('a catalog revision shown before it is published', () => {
  const SALE = { kind: 'template', locale: 'en', subject: 'Spring sale', parts: [{ kind: 'text', text: 'The spring sale ends soon. ' }, { kind: 'slot', slotId: 's1', type: 'price' }] };
  const LAST_DAYS = {
    kind: 'template', locale: 'en', subject: 'Spring sale, last days',
    parts: [{ kind: 'text', text: 'The spring sale ends on Sunday. ' }, { kind: 'slot', slotId: 's1', type: 'price' }, { kind: 'text', text: ' ' }, { kind: 'slot', slotId: 's2', type: 'unsubscribe' }],
  };
  const entry = (current: number | null, revisions: object[]) => ({ entryId: 'e1', kind: 'template', locale: 'en', productId: null, channel: { id: 'ch1', name: 'Spring letters' }, current, revisions });
  const twoVersions = entry(1, [
    revision('r2', 2, 'proposed', { value: LAST_DAYS, summary: 'Spring sale, last days', createdAt: '2026-03-02T09:30:00.000Z' }),
    revision('r1', 1, 'published', { value: SALE, summary: 'Spring sale', publishedBy: { id: 'p-mona', name: 'Mona' } }),
  ]);
  const withCatalog = (entries: object[], extra: Record<string, [number, unknown]> = {}) => mockApi({ ...routes(), [`GET /api/outbound/catalog?${Q}`]: [200, { departmentId: DEPT, entries }], ...extra });
  const catalogOf = async () => (await screen.findByRole('heading', { name: 'Department catalog' })).closest('section') as HTMLElement;

  it('shows the subject, the words with the places a message fills in, the language, the version and who proposed it when', async () => {
    withCatalog([twoVersions]);
    show();
    const shown = within(await catalogOf()).getByRole('region', { name: 'Revision 2' });
    expect(shown).toHaveTextContent('Spring sale, last days');
    expect(shown).toHaveTextContent('The spring sale ends on Sunday.');
    expect(within(shown).getAllByText('Price', { selector: '.outbound-slot' }).length).toBeGreaterThan(0);
    expect(within(shown).getAllByText('How to stop messages', { selector: '.outbound-slot' }).length).toBeGreaterThan(0);
    expect(shown).toHaveTextContent('English');
    expect(shown).toHaveTextContent('Proposed by Max on 02/03/2026');
  });

  it('shows what changed from the version messages use, and publishes the version shown', async () => {
    const calls = withCatalog([twoVersions], { 'POST /api/outbound/catalog/r2/publish': [200, { id: 'r2', status: 'published' }] });
    const user = userEvent.setup();
    show();
    const shown = within(await catalogOf()).getByRole('region', { name: 'Revision 2' });
    const changed = within(shown).getByRole('group', { name: 'What changed from revision 1, which messages use' });
    expect([...changed.querySelectorAll('ins')].map(e => e.textContent)).toEqual(['sale, last days', 'on Sunday.', 'How to stop messages']);
    expect([...changed.querySelectorAll('del')].map(e => e.textContent)).toEqual(['sale', 'soon.']);
    await user.click(within(shown).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(calls.filter(c => c.method === 'POST').map(c => [c.path, c.body])).toEqual([['/api/outbound/catalog/r2/publish', { revision: 2, newest: 2 }]]));
  });

  /* Design #1181, V1 and V2: a space outside the marks between words taken out and words put in, in either direction, and
     no space marked; words put in read in the text's own colour, the change shown by the success underline. */
  it('puts a space outside the marks between the words taken out and those put in, and marks words only', async () => {
    withCatalog([twoVersions]);
    show();
    const shown = within(await catalogOf()).getByRole('region', { name: 'Revision 2' });
    const changed = within(shown).getByRole('group', { name: 'What changed from revision 1, which messages use' });
    const marked = (p: Element) => [...p.childNodes].map(n => (n.nodeName === 'DEL' ? `[-${n.textContent}-]` : n.nodeName === 'INS' ? `{+${n.textContent}+}` : n.textContent)).join('');
    expect([...changed.querySelectorAll('.outbound-words')].map(marked)).toEqual([
      'Spring [-sale-] {+sale, last days+}',
      'The spring sale ends [-soon.-] {+on Sunday.+} Price {+How to stop messages+}',
    ]);
    expect(decl('.outbound-changes del + ins', 'margin-inline-start')).toBeUndefined();
  });

  it('shows the words put in in the text\'s own colour, underlined 2 px in the colour of success', () => {
    expect(decl('.outbound-changes ins', 'color')).toBe('var(--ink)');
    expect(decl('.outbound-changes ins', 'text-decoration-line')).toBe('underline');
    expect(decl('.outbound-changes ins', 'text-decoration-thickness')).toBe('2px');
    expect(decl('.outbound-changes ins', 'text-decoration-color')).toBe('var(--ok)');
    expect(decl('.outbound-changes del', 'color')).toBe('var(--pink-ink)');
    expect(decl('.outbound-changes del', 'text-decoration')).toBe('line-through');
  });

  it('marks an entry nothing of which is in use yet as new', async () => {
    withCatalog([entry(null, [revision('r1', 1, 'proposed', { value: SALE, summary: 'Spring sale' })])]);
    show();
    const shown = within(await catalogOf()).getByRole('region', { name: 'Revision 1' });
    expect(shown).toHaveTextContent('New: no version of this entry is in use yet.');
    expect(shown.querySelector('ins, del')).toBeNull();
  });

  it('shows a price by its value', async () => {
    const price = { kind: 'price', amount: '10.00', currency: 'USD', scale: 2, rounding: 'half_up', discountId: null, termsId: null, validFrom: '2026-01-01T00:00:00.000Z', validUntil: null };
    withCatalog([{ ...entry(null, [revision('r1', 1, 'proposed', { value: price, summary: '10.00 USD' })]), kind: 'price', locale: null }]);
    show();
    const shown = within(await catalogOf()).getByRole('region', { name: 'Revision 1' });
    expect(shown).toHaveTextContent('10.00 USD');
  });

  it('says in plain words that the entry changed while it was shown, and reads it again', async () => {
    const calls = withCatalog([twoVersions], { 'POST /api/outbound/catalog/r2/publish': [409, { error: { code: 'conflict', message: 'This entry changed after you looked at it.', reason: 'outbound_changed' } }] });
    const user = userEvent.setup();
    show();
    const shown = within(await catalogOf()).getByRole('region', { name: 'Revision 2' });
    await user.click(within(shown).getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText('This entry got another version while you were looking at it. Look at it again before you publish or take it back.')).toBeInTheDocument();
    expect(calls.filter(c => c.path === `/api/outbound/catalog?${Q}`).length).toBeGreaterThan(1);
  });

  it('speaks Russian', async () => {
    withCatalog([twoVersions]);
    show('ru');
    const catalog = (await screen.findByRole('heading', { name: 'Каталог отдела' })).closest('section') as HTMLElement;
    const shown = within(catalog).getByRole('region', { name: 'Ревизия 2' });
    expect(within(shown).getAllByText('Цена', { selector: '.outbound-slot' }).length).toBeGreaterThan(0);
    expect(shown).toHaveTextContent('английский');
    expect(within(shown).getByRole('group', { name: 'Что изменилось по сравнению с ревизией 1, которую используют письма' })).toBeInTheDocument();
  });
});

/* Design #1176, M1: in a page right to left each whole sentence of the panel keeps its own direction, so a sentence in a
   language written left to right ends with its full stop instead of starting with it; the page stays mirrored. */
describe('the panel right to left', () => {
  it('keeps each whole sentence in its own direction: notes, hints, problems under fields, refusals, the catalog and its view', async () => {
    document.documentElement.dir = 'rtl';
    onTestFinished(() => { document.documentElement.removeAttribute('dir'); });
    const words = (text: string) => ({ kind: 'template', locale: 'en', subject: 'Spring sale', parts: [{ kind: 'text', text }, { kind: 'slot', slotId: 's1', type: 'price' }] });
    const entry = {
      entryId: 'e1', kind: 'template', locale: 'en', productId: null, channel: null, current: 1,
      revisions: [revision('r2', 2, 'proposed', { value: words('The sale ends on Sunday. ') }), revision('r1', 1, 'published', { value: words('The sale ends soon. ') })],
    };
    mockApi({
      ...routes(), [`GET /api/outbound/catalog?${Q}`]: [200, { departmentId: DEPT, entries: [entry] }],
      'POST /api/outbound/catalog/r2/publish': [409, { error: { code: 'conflict', message: 'Changed.', reason: 'outbound_changed' } }],
    });
    const user = userEvent.setup();
    const { container } = show();
    const spring = (await screen.findByRole('heading', { name: 'Spring letters' })).closest('.imp') as HTMLElement;
    const news = screen.getByRole('heading', { name: 'News' }).closest('.imp') as HTMLElement;
    await user.click(within(spring).getByRole('button', { name: 'Add an address' }));
    const form = within(spring).getByRole('form', { name: 'Add an address' });
    await user.type(within(form).getByLabelText('Email address'), 'team test');
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    await user.click(within(news).getByRole('button', { name: 'Set limits and sending' }));
    await user.click(screen.getByRole('button', { name: 'New channel' }));
    const shown = screen.getByRole('region', { name: 'Revision 2' });
    await user.click(within(shown).getByRole('button', { name: 'Publish' }));
    expect(await within(shown.closest('li')!).findByRole('alert')).toBeInTheDocument();
    expect(within(form).getByLabelText('Email address')).toHaveAccessibleDescription('This is not an email address. Check it and try again.');
    expect(unisolated(container)).toEqual([]);
  });
});

describe('contact template fields', () => {
  it('adds named private contact fields with the consented address', async () => {
    const calls = mockApi({ ...routes([CHANNEL]), 'POST /api/outbound/contacts': [200, { contactId: 'k-fields', permissionId: 'p-fields' }] });
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Add an address' }));
    const form = screen.getByRole('form', { name: 'Add an address' });
    await user.type(within(form).getByLabelText('Email address'), 'ann@shop.example');
    await user.type(within(form).getByLabelText('Where they agreed'), 'Signup form');
    await user.type(within(form).getByLabelText('Proof of their consent'), 'Recorded consent');
    await user.click(within(form).getByRole('checkbox'));
    await user.type(within(form).getByLabelText('Field name 1'), 'name');
    await user.type(within(form).getByLabelText('Field value 1'), 'Ann');
    await user.click(within(form).getByRole('button', { name: 'Add a field' }));
    await user.type(within(form).getByLabelText('Field name 2'), 'personal_line');
    await user.type(within(form).getByLabelText('Field value 2'), 'Thank you for visiting.');
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(calls.find(c => c.method === 'POST')?.body).toMatchObject({ fields: { name: 'Ann', personal_line: 'Thank you for visiting.' } }));
  });

  it('focuses the invalid field name and then its missing value without sending anything', async () => {
    const calls = mockApi(routes([CHANNEL]));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Add an address' }));
    const form = screen.getByRole('form', { name: 'Add an address' });
    await user.type(within(form).getByLabelText('Email address'), 'ann@shop.example');
    await user.type(within(form).getByLabelText('Where they agreed'), 'Signup form');
    await user.type(within(form).getByLabelText('Proof of their consent'), 'Recorded consent');
    await user.click(within(form).getByRole('checkbox'));
    const name = within(form).getByLabelText('Field name 1');
    await user.type(name, 'display name');
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    await user.clear(name);
    await user.type(name, 'name');
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    expect(within(form).getByLabelText('Field value 1')).toHaveFocus();
    expect(calls.filter(c => c.method === 'POST')).toEqual([]);
  });

  it('imports a table and shows skipped row numbers and reasons without private cells', async () => {
    const calls = mockApi({ ...routes([CHANNEL]), 'POST /api/outbound/contacts/import': [200, { added: 1, updated: 0, skipped: [{ row: 3, reason: 'consent_missing' }] }] });
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Import addresses' }));
    const form = screen.getByRole('form', { name: 'Import addresses' });
    const csv = 'address,consent,name\nann@shop.example,yes,Ann\nno@shop.example,,Private skipped cell';
    await user.upload(within(form).getByLabelText('CSV or XLSX file'), new File([csv], 'contacts.csv', { type: 'text/csv' }));
    await user.type(within(form).getByLabelText('Where they agreed'), 'Signup sheet');
    await user.type(within(form).getByLabelText('Proof of their consent'), 'Recorded consent');
    await user.click(within(form).getByRole('button', { name: 'Import' }));
    expect(await within(form).findByRole('status')).toHaveTextContent('Added: 1. Updated: 0. Skipped: 1.');
    expect(form).toHaveTextContent('Row 3: no consent');
    expect(form).not.toHaveTextContent('Private skipped cell');
    await waitFor(() => expect(calls.find(c => c.method === 'POST')?.body).toMatchObject({ channelId: 'ch1', filename: 'contacts.csv', source: 'Signup sheet' }));
  });

  it('focuses missing import inputs and keeps server diagnostics out of the form', async () => {
    const calls = mockApi({ ...routes([CHANNEL]), 'POST /api/outbound/contacts/import': [400, { error: { message: 'Private parser cell: Ann', code: 'validation' } }] });
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Import addresses' }));
    const form = screen.getByRole('form', { name: 'Import addresses' });
    const submit = within(form).getByRole('button', { name: 'Import' });
    const file = within(form).getByLabelText('CSV or XLSX file');
    await user.click(submit);
    expect(file).toHaveFocus();
    expect(file).toHaveAttribute('aria-invalid', 'true');
    await user.upload(file, new File(['address,consent,name\nann@shop.example,yes,Ann'], 'contacts.csv', { type: 'text/csv' }));
    await user.click(submit);
    expect(within(form).getByLabelText('Where they agreed')).toHaveFocus();
    await user.type(within(form).getByLabelText('Where they agreed'), 'Signup sheet');
    await user.click(submit);
    expect(within(form).getByLabelText('Proof of their consent')).toHaveFocus();
    expect(calls.filter(call => call.method === 'POST')).toEqual([]);
    await user.type(within(form).getByLabelText('Proof of their consent'), 'Recorded consent');
    await user.click(submit);
    expect(await within(form).findByRole('alert')).toHaveTextContent('Could not import the table.');
    expect(form).not.toHaveTextContent('Private parser cell');
  });
});
