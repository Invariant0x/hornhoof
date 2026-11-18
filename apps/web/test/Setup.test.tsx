import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ru } from '../src/i18n/ru';
import { Setup } from '../src/screens/Setup';
import { mockApi, type Call, withKey } from './api-mock';
import { decl } from './css';
import { commandCode } from './command-code';

/* The same long random name for every start, so the tests know what the Link field holds before anything is typed. */
vi.mock('@hornhoof/protocol/link', async importOriginal => ({ ...(await importOriginal<typeof import('@hornhoof/protocol/link')>()), randomLinkName: () => 'r4nd0mr4nd0mr4nd0m' }));

const RANDOM = 'r4nd0mr4nd0mr4nd0m';
const CREATED = { company: { id: 'c1', name: 'Acme' }, person: { id: 'p1', name: 'Ivan', email: 'ivan@acme.com', title: 'CEO' } };
const CHECK_ACME = 'GET /api/setup/names/acme?code=LINK-CODE-123';
const MADE = { name: RANDOM, url: `https://${RANDOM}.hornhoof.org` };
const linkAnswer = (certificate: boolean) => [200, { link: MADE, domain: 'hornhoof.org', tls: { mode: certificate ? 'https' : 'http', certificate, expiresAt: null, failedAt: null } }] as [number, unknown];
const AGREEMENT = 'Let\'s Encrypt Subscriber Agreement';
/* The setup itself, among the name checks the screen makes while the company name is typed. */
const posted = (calls: Call[]) => calls.filter(c => c.method === 'POST');

/* The Link field starts on a random name, so a test that wants its own name writes it there. */
async function typeLinkName(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.clear(screen.getByLabelText('Link'));
  await user.type(screen.getByLabelText('Link'), name);
}

async function fillFirstTwoSteps(user: ReturnType<typeof userEvent.setup>, password = 'correct horse battery') {
  await user.type(screen.getByLabelText('Company name'), 'Acme');
  await typeLinkName(user, 'acme');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.type(screen.getByLabelText('Your name'), 'Ivan');
  await user.type(screen.getByLabelText('Email'), 'ivan@acme.com');
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Next' }));
}

describe('Setup', () => {
  /* The server logs the setup link, and the link carries the code. */
  beforeEach(() => window.history.replaceState(null, '', '/setup?code=LINK-CODE-123'));
  afterEach(() => vi.useRealTimers());

  it('keeps Next disabled until the company has a name', async () => {
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Name your company' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.type(screen.getByLabelText('Company name'), '   ');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.type(screen.getByLabelText('Company name'), 'Acme');
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('asks for a longer password', async () => {
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    await fillFirstTwoSteps(user, 'short');
    expect(screen.getByText('Use at least 10 characters.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
  });

  it('offers the company templates and starts empty by default', async () => {
    render(<Setup onDone={() => {}} />);
    expect(screen.getByRole('radio', { name: /Start empty/ })).toBeChecked();
    /* A template brings its people, who wait only for a subscription; the card counts the turnkey teams among them. */
    expect(screen.getByText(/departments and their employees right away/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Project team/ })).toHaveAccessibleName(expect.stringContaining('21 employees'));
    /* The eight ready-made companies, named by the template, not by the scheme picture. */
    expect(screen.getAllByRole('radio', { name: /Project team|Startup|Studio with products|Full company|Cybersecurity company|Open-source project|Agency|Research lab|Home/ })).toHaveLength(9);
    /* The scheme is a picture only, so a screen reader reads the template name and the "Departments:" line, not "Department scheme". */
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('radio', { name: /Full company/ })).toHaveAccessibleName(expect.stringContaining('Departments: Operations, Development'));
    for (const radio of screen.getAllByRole('radio')) expect(radio).toHaveAccessibleName(expect.not.stringContaining('Department scheme'));
  });

  it('sends the chosen company template with the company', async () => {
    const calls = mockApi({ 'POST /api/setup': [201, CREATED] });
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    await user.type(screen.getByLabelText('Company name'), 'Acme');
    await user.click(screen.getByRole('radio', { name: /Studio with products/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('Your name'), 'Ivan');
    await user.type(screen.getByLabelText('Email'), 'ivan@acme.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('radio', { name: 'API key' }));
    await user.selectOptions(screen.getByLabelText('Provider'), 'Anthropic');
    await user.type(screen.getByLabelText('Key'), 'sk-ant-xyz12345');
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(posted(calls)[0]!.body).toMatchObject({ companyName: 'Acme', template: 'studio' });
  });

  it('sends the API key choice and finishes', async () => {
    const calls = mockApi({ 'POST /api/setup': [201, CREATED] });
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<Setup onDone={onDone} />);
    await fillFirstTwoSteps(user);
    expect(screen.getByRole('heading', { name: 'Connect the orchestrator' })).toBeInTheDocument();
    expect(screen.getByText(/It can do anything in your company and in Hornhoof itself, sees everything, and can change its own system\./)).toBeInTheDocument();
    expect(ru.setup.orchestratorIntro).toContain('Он может все в вашей компании и в самом Hornhoof, видит все и может менять свою систему.');
    await user.click(screen.getByRole('radio', { name: 'API key' }));
    await user.selectOptions(screen.getByLabelText('Provider'), 'Anthropic');
    await user.type(screen.getByLabelText('Key'), 'sk-ant-xyz12345');
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(posted(calls)).toEqual([{
      method: 'POST',
      path: '/api/setup',
      body: {
        code: 'LINK-CODE-123',
        companyName: 'Acme',
        name: 'Ivan',
        email: 'ivan@acme.com',
        password: 'correct horse battery',
        title: 'CEO',
        orchestrator: { mode: 'api_key', provider: 'anthropic_api', apiKey: 'sk-ant-xyz12345' },
        link: { name: 'acme' },
      },
    }]);
    expect(onDone).toHaveBeenCalledWith({ welcome: true });
  });

  it('shows the node command for a personal subscription', async () => {
    const command = 'curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join JOIN-CODE-123';
    const calls = mockApi({ 'POST /api/setup': [201, { ...CREATED, command }] });
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<Setup onDone={onDone} />);
    await fillFirstTwoSteps(user);
    await user.click(screen.getByRole('radio', { name: 'My subscription' }));
    await user.click(screen.getByRole('radio', { name: 'Codex' }));
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(posted(calls)[0]!.body).toMatchObject({ orchestrator: { mode: 'personal', provider: 'codex' } });
    expect(await screen.findByRole('heading', { name: 'Connect your machine' })).toBeInTheDocument();
    expect(await screen.findByText(commandCode(withKey(command)))).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2);
    expect(screen.getByText('Agents will run on this machine with your subscription. People with access to this Hornhoof can give them work.')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Go to the map' }));
    expect(onDone).toHaveBeenCalled();
  });

  it('asks the CEO for a title and sends it', async () => {
    const calls = mockApi({ 'POST /api/setup': [201, CREATED] });
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    await user.type(screen.getByLabelText('Company name'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText('Your title')).toHaveValue('CEO');
    await user.clear(screen.getByLabelText('Your title'));
    await user.type(screen.getByLabelText('Your title'), 'Founder');
    await user.type(screen.getByLabelText('Your name'), 'Ivan');
    await user.type(screen.getByLabelText('Email'), 'ivan@acme.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('radio', { name: 'Later' }));
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(posted(calls)[0]!.body).toMatchObject({ title: 'Founder', orchestrator: { mode: 'later' } });
  });

  it('offers GLM as a personal plan for the orchestrator', async () => {
    const calls = mockApi({ 'POST /api/setup': [201, { ...CREATED, command: 'curl x' }] });
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    await fillFirstTwoSteps(user);
    await user.click(screen.getByRole('radio', { name: 'My subscription' }));
    await user.click(screen.getByRole('radio', { name: 'GLM' }));
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(posted(calls)[0]!.body).toMatchObject({ orchestrator: { mode: 'personal', provider: 'glm' } });
  });

  it('offers a Google AI plan, which Antigravity runs, as a personal plan for the orchestrator', async () => {
    /* The clock also runs by itself, so the screen's own waiting works beside the step the test takes. */
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = mockApi({ 'POST /api/setup': [201, { ...CREATED, command: 'curl x' }] });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Setup onDone={() => {}} />);
    /* The random name's check goes out before anything is typed, as it does on a slow machine. */
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await fillFirstTwoSteps(user);
    await user.click(screen.getByRole('radio', { name: 'My subscription' }));
    expect(screen.getByRole('radio', { name: 'My subscription' })).toHaveAccessibleDescription(/Google AI plan/);
    await user.click(screen.getByRole('radio', { name: 'Antigravity' }));
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(posted(calls)[0]!.body).toMatchObject({ orchestrator: { mode: 'personal', provider: 'antigravity' } });
  });

  it('takes the setup code from the link without asking for it', () => {
    render(<Setup onDone={() => {}} />);
    expect(screen.queryByLabelText('Setup code')).not.toBeInTheDocument();
  });

  it('goes back to the setup code when the server refuses it', async () => {
    mockApi({ 'POST /api/setup': [403, { error: { code: 'forbidden', message: 'This setup code is not right.', reason: 'setup_code' } }] });
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    await fillFirstTwoSteps(user);
    await user.click(screen.getByRole('radio', { name: 'Later' }));
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByRole('heading', { name: 'Name your company' })).toBeInTheDocument();
    expect(screen.getByLabelText('Setup code')).toHaveValue('LINK-CODE-123');
    expect(screen.getByText('This setup code is not right. Open the setup link the installer showed, or take the code from the server log.')).toBeInTheDocument();
    expect(screen.getByLabelText('Company name')).toHaveValue('Acme');
  });

  it('shows the server message when setup fails', async () => {
    mockApi({ 'POST /api/setup': [409, { error: { code: 'conflict', message: 'This Hornhoof is already set up.' } }] });
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    await fillFirstTwoSteps(user);
    await user.click(screen.getByRole('radio', { name: 'Later' }));
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByText('This Hornhoof is already set up.')).toBeInTheDocument();
  });
});

describe('the public link on the setup screen', () => {
  beforeEach(() => window.history.replaceState(null, '', '/setup?code=LINK-CODE-123'));

  /* jsdom does not lay out: the rules are what keeps the row of the name and ".hornhoof.org" inside a phone's screen. */
  it('lets the name field give way on a narrow screen, so the row with the domain fits', () => {
    render(<Setup onDone={() => {}} linkDomain="hornhoof.org" />);
    const row = screen.getByLabelText('Link').closest('.link-input');
    expect(row).toHaveTextContent('.hornhoof.org');
    /* A form field's own width counts toward the row's narrowest size unless it is set in %; then it takes what the
       domain leaves. */
    expect(decl('.link-input input', 'width')).toBe('100%');
    expect(decl('.link-input input', 'min-width')).toBe('0');
    expect(decl('.link-input .link-domain', 'white-space')).toBe('nowrap');
  });

  it('breaks the note under the field inside the longest address, so the note does not widen the row', async () => {
    const longest = 'a'.repeat(63);
    mockApi({ [`GET /api/setup/names/${longest}?code=LINK-CODE-123`]: [200, { name: longest, free: true }] });
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} linkDomain="hornhoof.org" />);
    await typeLinkName(user, longest);
    const note = await screen.findByText(`${longest}.hornhoof.org is free.`);
    /* The address is one word with no place to wrap, wider than a phone; the note may break inside it. */
    expect(note.matches('.link-name > span')).toBe(true);
    expect(decl('.link-name > span', 'overflow-wrap')).toBe('anywhere');
  });

  it('starts the link with a long random name and keeps it while the company name is typed', async () => {
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} linkDomain="hornhoof.org" />);
    expect(screen.getByRole('checkbox', { name: 'Open Hornhoof on the internet' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Open Hornhoof on the internet' })).toHaveAccessibleDescription(/open it later in Settings, under Company & access\.$/);
    expect(screen.getByLabelText('Link')).toHaveValue(RANDOM);
    await user.type(screen.getByLabelText('Company name'), 'Рога и копыта');
    expect(screen.getByLabelText('Link')).toHaveValue(RANDOM);
    expect(screen.getByText('.hornhoof.org')).toBeInTheDocument();
    expect(screen.getByText(/A random name does not say whose company it is/)).toBeInTheDocument();
  });

  it('asks Hornhoof, with the setup code, whether the name is free', async () => {
    const calls = mockApi({ [CHECK_ACME]: [200, { name: 'acme', free: true }], 'GET /api/setup/names/globex?code=LINK-CODE-123': [200, { name: 'globex', free: false, reason: 'taken' }] });
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} linkDomain="hornhoof.org" />);
    await user.type(screen.getByLabelText('Company name'), 'Acme');
    await typeLinkName(user, 'acme');
    expect(await screen.findByText('acme.hornhoof.org is free.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    await user.clear(screen.getByLabelText('Link'));
    await user.type(screen.getByLabelText('Link'), 'globex');
    expect(await screen.findByText('This name is taken. Pick another one.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(calls.every(c => c.path.startsWith('/api/setup/names/'))).toBe(true);
  });

  it('keeps a name the person wrote when the company name changes, and refuses one no link can have', async () => {
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    await user.type(screen.getByLabelText('Company name'), 'Acme');
    await user.clear(screen.getByLabelText('Link'));
    await user.type(screen.getByLabelText('Link'), 'my-firm-');
    expect(screen.getByText('Use Latin letters a to z, digits and hyphens, with no hyphen at the start or the end.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.type(screen.getByLabelText('Link'), '{Backspace}');
    await user.type(screen.getByLabelText('Company name'), ' Corp');
    expect(screen.getByLabelText('Link')).toHaveValue('my-firm');
  });

  it('gives a long random name on a click, which says nothing of the company', async () => {
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    await typeLinkName(user, 'my-firm');
    expect(screen.getByText(/A name you pick shows in public certificate logs/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Random name' }));
    expect(screen.getByLabelText('Link')).toHaveValue(RANDOM);
    expect(screen.getByText(/A random name does not say whose company it is/)).toBeInTheDocument();
  });

  it('sends no link when it is turned off', async () => {
    const calls = mockApi({ 'POST /api/setup': [201, CREATED] });
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    await user.type(screen.getByLabelText('Company name'), 'Acme');
    await user.click(screen.getByRole('checkbox', { name: 'Open Hornhoof on the internet' }));
    expect(screen.queryByLabelText('Link')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('Your name'), 'Ivan');
    await user.type(screen.getByLabelText('Email'), 'ivan@acme.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('radio', { name: 'Later' }));
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(posted(calls)[0]!.body).not.toHaveProperty('link');
  });

  it('goes back to the link when its name was taken meanwhile', async () => {
    mockApi({ 'POST /api/setup': [409, { error: { code: 'conflict', message: 'This link is taken already. Pick another name.', reason: 'link_taken' } }] });
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    await fillFirstTwoSteps(user);
    await user.click(screen.getByRole('radio', { name: 'Later' }));
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByRole('heading', { name: 'Name your company' })).toBeInTheDocument();
    expect(screen.getByText('This link is taken already. Pick another name.')).toBeInTheDocument();
    expect(screen.getByLabelText('Link')).toHaveValue('acme');
  });

  it('offers to go on without the link when hornhoof.org does not answer', async () => {
    mockApi({ 'POST /api/setup': [503, { error: { code: 'unavailable', message: 'hornhoof.org does not answer now.', reason: 'relay_unreachable' } }] });
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    await fillFirstTwoSteps(user);
    await user.click(screen.getByRole('radio', { name: 'Later' }));
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByText('hornhoof.org does not answer now. Try again in a few minutes.')).toBeInTheDocument();
    expect(screen.getByText(/turn off "Open Hornhoof on the internet", and open the link later in Settings, under Company & access\./)).toBeInTheDocument();
  });
});

describe("the setup's command and its owner's key", () => {
  beforeEach(() => window.history.replaceState(null, '', '/setup?code=LINK-CODE-123'));

  it('makes the key with the password just typed in the form, and asks for nothing', async () => {
    const command = 'curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join JOIN-CODE-123';
    const calls = mockApi({ 'POST /api/setup': [201, { ...CREATED, command }], 'GET /api/me/key': [200, { key: null }] });
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    await fillFirstTwoSteps(user, 'a password typed here');
    await user.click(screen.getByRole('radio', { name: 'My subscription' }));
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByRole('heading', { name: 'Connect your machine' })).toBeInTheDocument();
    await vi.waitFor(() => expect(calls.some(call => call.method === 'PUT' && call.path === '/api/me/key')).toBe(true));
    const sent = calls.find(call => call.method === 'PUT' && call.path === '/api/me/key')!.body as { password: string; publicKey: string };
    expect(sent.password).toBe('a password typed here');
    expect(await screen.findByText(commandCode(`${command} --owner-key ${sent.publicKey}`))).toBeInTheDocument();
    /* The only password field is long gone: nothing was asked a second time. */
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });
});

describe('the new link on the setup screen', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/setup?code=LINK-CODE-123');
    /* The clock also runs by itself, so the screen's own waiting (findBy) works beside the timers the test moves. */
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => vi.useRealTimers());

  const setUpWithLink = async (onDone: (done: { welcome: boolean }) => void = () => {}) => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Setup onDone={onDone} />);
    await fillFirstTwoSteps(user);
    await user.click(screen.getByRole('radio', { name: 'Later' }));
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    return user;
  };

  it('shows the new link once its certificate is in', async () => {
    let asked = 0;
    mockApi({ 'POST /api/setup': [201, { ...CREATED, link: MADE }], 'GET /api/link': () => linkAnswer(++asked > 1) });
    await setUpWithLink();
    expect(await screen.findByText('Getting the certificate for your link. This takes under a minute.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: MADE.url })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: AGREEMENT })).toHaveAttribute('href', 'https://letsencrypt.org/repository/');
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByText('People open your company from anywhere at this link:')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: MADE.url })).toHaveAttribute('href', MADE.url);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: AGREEMENT })).toBeInTheDocument();
  });

  it('shows the link after 90 seconds anyway', async () => {
    mockApi({ 'POST /api/setup': [201, { ...CREATED, link: MADE }], 'GET /api/link': () => linkAnswer(false) });
    await setUpWithLink();
    await screen.findByText('Getting the certificate for your link. This takes under a minute.');
    await act(() => vi.advanceTimersByTimeAsync(89_000));
    expect(screen.queryByRole('link', { name: MADE.url })).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getByText('The link works now. Its own certificate comes on its own; until then the connection is encrypted to hornhoof.org.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: MADE.url })).toBeInTheDocument();
  });

  it('goes on with Next to the command card, or to the map when there is no command', async () => {
    const command = 'curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join JOIN-CODE-123';
    mockApi({ 'POST /api/setup': [201, { ...CREATED, link: MADE, command }], 'GET /api/link': () => linkAnswer(true) });
    const user = await setUpWithLink();
    await act(() => vi.advanceTimersByTimeAsync(0));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('heading', { name: 'Connect your machine' })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(await screen.findByText(commandCode(withKey(command)))).toBeInTheDocument();
  });

  it('goes to the map with Next when the setup made no command', async () => {
    mockApi({ 'POST /api/setup': [201, { ...CREATED, link: MADE }], 'GET /api/link': () => linkAnswer(true) });
    const onDone = vi.fn();
    const user = await setUpWithLink(onDone);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(onDone).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(onDone).toHaveBeenCalledWith({ welcome: true });
  });

  it('goes on as today without a link', async () => {
    mockApi({ 'POST /api/setup': [201, CREATED] });
    const onDone = vi.fn();
    await setUpWithLink(onDone);
    expect(onDone).toHaveBeenCalledWith({ welcome: true });
    expect(screen.queryByRole('link', { name: AGREEMENT })).not.toBeInTheDocument();
  });
});

describe('Setup without the setup link', () => {
  it('asks for the setup code before anything else and sends it', async () => {
    const calls = mockApi({ 'POST /api/setup': [201, CREATED] });
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    expect(screen.getByText(/The code is also in the server log/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Company name'), 'Acme');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.type(screen.getByLabelText('Setup code'), ' TYPED-CODE ');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('Your name'), 'Ivan');
    await user.type(screen.getByLabelText('Email'), 'ivan@acme.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('radio', { name: 'Later' }));
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(posted(calls)[0]!.body).toMatchObject({ code: 'TYPED-CODE', companyName: 'Acme' });
  });
});

describe('Setup from a recovery file', () => {
  const FILE = '# Hornhoof recovery file for Acme.\n{"v":1}\n';
  const ID = '0f0f0f0f-0000-4000-8000-00000000000a';
  const BUNDLE = { id: ID, dumpedAt: '2026-11-10T08:00:00.000Z', reason: 'timer', size: 5 * 1024 * 1024, from: 'm1' };
  const view = (over: object = {}) => ({ company: 'c1', link: 'https://acme.hornhoof.org', bundles: [], restore: null, ...over });

  beforeEach(() => window.history.replaceState(null, '', '/setup?code=LINK-CODE-123'));
  afterEach(() => vi.useRealTimers());

  it('restores from a recovery file', async () => {
    let bundles: object[] = [];
    let needed = true;
    let restore: object | null = null;
    const calls = mockApi({
      'POST /api/recovery': [200, view()],
      'GET /api/recovery?code=LINK-CODE-123': () => (needed ? [200, view({ bundles, restore })] : [404, { error: { code: 'not_found', reason: 'not_recovering' } }]),
      'POST /api/recovery/restore': () => {
        restore = { attempt: 'a1', id: ID, state: 'running', step: 'load', line: 'Loading the backup.', at: BUNDLE.dumpedAt, kept: null };
        return [202, { attempt: 'a1' }];
      },
      'GET /api/setup': () => [200, { needed, linkDomain: 'hornhoof.org', recovering: needed }],
    });
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Restore from a recovery file' }));
    expect(screen.getByText('Choose the recovery file you saved in Settings, under Company & access.')).toBeInTheDocument();
    /* The code came with the setup link, so only the file is asked for. */
    expect(screen.queryByLabelText('Setup code')).not.toBeInTheDocument();
    await user.upload(screen.getByLabelText('Recovery file'), new File([FILE], 'hornhoof-recovery.txt', { type: 'text/plain' }));
    expect(await screen.findByText('Waiting for backups. Machines of the company that are still on send theirs within about 15 minutes.')).toBeInTheDocument();
    expect(posted(calls)).toEqual([{ method: 'POST', path: '/api/recovery', body: { code: 'LINK-CODE-123', file: FILE } }]);
    expect(screen.getByLabelText('Or upload a backup file')).toBeInTheDocument();
    /* A machine that survived sends a backup: the screen finds it at its next look. */
    bundles = [BUNDLE];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    const pick = await screen.findByRole('button', { name: /^Restore the backup of / });
    expect(pick).toHaveTextContent('Restore this one');
    await user.click(pick);
    expect(posted(calls).at(-1)).toEqual({ method: 'POST', path: '/api/recovery/restore', body: { code: 'LINK-CODE-123', id: ID } });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(await screen.findByText('Loading it into a new database')).toHaveAttribute('aria-current', 'step');
    expect(screen.queryByRole('button', { name: /^Restore the backup of / })).not.toBeInTheDocument();
    /* The company is back: the restored server knows it, and the person signs in as before. */
    needed = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(await screen.findByText('Restored. Sign in as before. If a plan was signed in on a lost machine, sign it in again under Subscriptions on a machine that is on.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/');
  });

  it('offers the backups again after a restore that did not go through', async () => {
    let restore: object | null = null;
    let has = true;
    mockApi({
      'POST /api/recovery': [200, view({ bundles: [BUNDLE] })],
      'GET /api/recovery?code=LINK-CODE-123': () => (has ? [200, view({ bundles: [BUNDLE], restore })] : [404, { error: { code: 'not_found', reason: 'not_recovering' } }]),
      'POST /api/recovery/restore': () => {
        restore = { attempt: 'a1', id: ID, state: 'running', step: 'fetch', line: '', at: BUNDLE.dumpedAt, kept: null };
        return [202, { attempt: 'a1' }];
      },
      'GET /api/setup': [200, { needed: true, linkDomain: 'hornhoof.org', recovering: false }],
    });
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Restore from a recovery file' }));
    await user.upload(screen.getByLabelText('Recovery file'), new File([FILE], 'hornhoof-recovery.txt', { type: 'text/plain' }));
    await user.click(await screen.findByRole('button', { name: /^Restore the backup of / }));
    expect(await screen.findByText('Getting the backup')).toHaveAttribute('aria-current', 'step');
    expect(screen.queryByRole('button', { name: 'Set up a new company instead' })).not.toBeInTheDocument();
    /* The keeper could not open it: the server still has the file, so the backups and the way out are back. */
    restore = { attempt: 'a1', id: ID, state: 'failed', step: 'open', line: 'This backup could not be opened.', at: BUNDLE.dumpedAt, kept: null };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(await screen.findByText('This backup could not be opened.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Restore the backup of / })).toBeInTheDocument();
    expect(screen.getByLabelText('Or upload a backup file')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up a new company instead' })).toBeInTheDocument();
    /* A restore that got as far as the databases restarts the server, which then has no file any more and no company
       either: the person is asked for the file again. */
    await user.click(screen.getByRole('button', { name: /^Restore the backup of / }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(await screen.findByText('Getting the backup')).toBeInTheDocument();
    has = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(await screen.findByText('The server started again and no longer has the recovery file. If a restore was running, it did not finish. Choose the file again.')).toBeInTheDocument();
    expect(screen.getByLabelText('Recovery file')).toBeInTheDocument();
    expect(screen.queryByText('Getting the backup')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up a new company instead' })).toBeInTheDocument();
  });

  it('asks for the setup code when the link brought none, says why a file was refused, and goes back', async () => {
    window.history.replaceState(null, '', '/setup');
    const calls = mockApi({ 'POST /api/recovery': [400, { error: { code: 'validation', message: 'This is not a Hornhoof recovery file.', reason: 'recovery_file_invalid' } }] });
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Restore from a recovery file' }));
    await user.type(screen.getByLabelText('Setup code'), 'TYPED-CODE');
    await user.upload(screen.getByLabelText('Recovery file'), new File(['not a file'], 'notes.txt', { type: 'text/plain' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This is not a Hornhoof recovery file.');
    expect(posted(calls)).toEqual([{ method: 'POST', path: '/api/recovery', body: { code: 'TYPED-CODE', file: 'not a file' } }]);
    await user.click(screen.getByRole('button', { name: 'Set up a new company instead' }));
    expect(screen.getByRole('heading', { name: 'Name your company' })).toBeInTheDocument();
  });

  it('takes a backup file the person uploads, by the name the file gives itself', async () => {
    const calls = mockApi({
      'POST /api/recovery': [200, view()],
      'GET /api/recovery?code=LINK-CODE-123': [200, view({ bundles: [BUNDLE] })],
      [`PUT /api/recovery/bundles/${ID}?code=LINK-CODE-123`]: [201, { id: ID }],
    });
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Restore from a recovery file' }));
    await user.upload(screen.getByLabelText('Recovery file'), new File([FILE], 'hornhoof-recovery.txt', { type: 'text/plain' }));
    /* A backup as it travels: a line that says what it is, a line with what was signed, then the sealed part. */
    const head = JSON.stringify({ manifest: JSON.stringify({ v: 1, id: ID }), signature: 's', certPem: 'c' });
    await user.upload(await screen.findByLabelText('Or upload a backup file'), new File([`hornhoof-bundle v1\n${head}\n`, new Uint8Array(2048)], 'backup.bundle'));
    expect(await screen.findByRole('button', { name: /^Restore the backup of / })).toBeInTheDocument();
    expect(calls.filter(call => call.method === 'PUT').map(call => call.path)).toEqual([`/api/recovery/bundles/${ID}?code=LINK-CODE-123`]);
    /* A file that is no backup is not sent anywhere. */
    await user.upload(screen.getByLabelText('Or upload a backup file'), new File(['holiday photos'], 'photos.zip'));
    expect(await screen.findByRole('alert')).toHaveTextContent('This is not a backup the recovery file opens.');
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(1);
  });

  it('opens on the backups when the server was given the file already', async () => {
    mockApi({ 'GET /api/recovery?code=LINK-CODE-123': [200, view({ bundles: [BUNDLE] })], 'GET /api/setup': [200, { needed: true, linkDomain: 'hornhoof.org', recovering: true }] });
    render(<Setup onDone={() => {}} recovering />);
    expect(await screen.findByRole('button', { name: /^Restore the backup of / })).toBeInTheDocument();
  });
});

