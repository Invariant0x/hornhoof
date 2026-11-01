import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Setup } from '../src/screens/Setup';
import { mockApi, type Call } from './api-mock';

const CREATED = { company: { id: 'c1', name: 'Acme' }, person: { id: 'p1', name: 'Ivan', email: 'ivan@acme.com', title: 'CEO' } };
const CHECK_ACME = 'GET /api/setup/names/acme?code=LINK-CODE-123';
/* The setup itself, among the name checks the screen makes while the company name is typed. */
const posted = (calls: Call[]) => calls.filter(c => c.method === 'POST');

async function fillFirstTwoSteps(user: ReturnType<typeof userEvent.setup>, password = 'correct horse battery') {
  await user.type(screen.getByLabelText('Company name'), 'Acme');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.type(screen.getByLabelText('Your name'), 'Ivan');
  await user.type(screen.getByLabelText('Email'), 'ivan@acme.com');
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Next' }));
}

describe('Setup', () => {
  /* The server logs the setup link, and the link carries the code. */
  beforeEach(() => window.history.replaceState(null, '', '/setup?code=LINK-CODE-123'));

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

  it('offers the company templates with their schemes and starts empty by default', async () => {
    render(<Setup onDone={() => {}} />);
    expect(screen.getByRole('radio', { name: /Start empty/ })).toBeChecked();
    /* The eight ready-made companies, each with a mini department scheme. */
    expect(screen.getAllByRole('radio', { name: /Project team|Startup|Studio with products|Full company|Cybersecurity company|Open-source project|Agency|Research lab|Home/ })).toHaveLength(9);
    expect(screen.getAllByRole('img', { name: 'Department scheme' })).toHaveLength(9);
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
    expect(screen.getByText(command)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
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
    const calls = mockApi({ 'POST /api/setup': [201, { ...CREATED, command: 'curl x' }] });
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    await fillFirstTwoSteps(user);
    await user.click(screen.getByRole('radio', { name: 'My subscription' }));
    expect(screen.getByRole('radio', { name: 'My subscription' })).toHaveAccessibleDescription(/Google AI plan/);
    await user.click(screen.getByRole('radio', { name: 'Antigravity' }));
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(calls[0]!.body).toMatchObject({ orchestrator: { mode: 'personal', provider: 'antigravity' } });
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

  it('opens Hornhoof on the internet at a link made from the company name as it is typed', async () => {
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} linkDomain="hornhoof.org" />);
    expect(screen.getByRole('checkbox', { name: 'Open Hornhoof on the internet' })).toBeChecked();
    await user.type(screen.getByLabelText('Company name'), 'Рога и копыта');
    expect(screen.getByLabelText('Link')).toHaveValue('roga-i-kopyta');
    expect(screen.getByText('.hornhoof.org')).toBeInTheDocument();
    expect(screen.getByText(/A name like this is easy to guess/)).toBeInTheDocument();
  });

  it('asks Hornhoof, with the setup code, whether the name is free', async () => {
    const calls = mockApi({ [CHECK_ACME]: [200, { name: 'acme', free: true }], 'GET /api/setup/names/globex?code=LINK-CODE-123': [200, { name: 'globex', free: false, reason: 'taken' }] });
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} linkDomain="hornhoof.org" />);
    await user.type(screen.getByLabelText('Company name'), 'Acme');
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

  it('gives a long random name on a click, which is hard to guess', async () => {
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    await user.type(screen.getByLabelText('Company name'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Random name' }));
    expect((screen.getByLabelText('Link') as HTMLInputElement).value).toMatch(/^[a-z0-9]{24}$/);
    expect(screen.getByText(/A random name is hard to guess/)).toBeInTheDocument();
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
    expect(screen.getByText(/turn off "Open Hornhoof on the internet"/)).toBeInTheDocument();
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
