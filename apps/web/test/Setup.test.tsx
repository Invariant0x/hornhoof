import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Setup } from '../src/screens/Setup';
import { mockApi } from './api-mock';

const CREATED = { company: { id: 'c1', name: 'Acme' }, person: { id: 'p1', name: 'Ivan', email: 'ivan@acme.com', title: 'CEO' } };

async function fillFirstTwoSteps(user: ReturnType<typeof userEvent.setup>, password = 'correct horse battery') {
  await user.type(screen.getByLabelText('Company name'), 'Acme');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.type(screen.getByLabelText('Your name'), 'Ivan');
  await user.type(screen.getByLabelText('Email'), 'ivan@acme.com');
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Next' }));
}

describe('Setup', () => {
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
    expect(calls).toEqual([{
      method: 'POST',
      path: '/api/setup',
      body: {
        companyName: 'Acme',
        name: 'Ivan',
        email: 'ivan@acme.com',
        password: 'correct horse battery',
        title: 'CEO',
        chief: { mode: 'api_key', provider: 'anthropic_api', apiKey: 'sk-ant-xyz12345' },
      },
    }]);
    expect(onDone).toHaveBeenCalled();
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
    expect(calls[0]!.body).toMatchObject({ chief: { mode: 'personal', provider: 'codex' } });
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
    expect(calls[0]!.body).toMatchObject({ title: 'Founder', chief: { mode: 'later' } });
  });

  it('offers GLM as a personal plan for the orchestrator', async () => {
    const calls = mockApi({ 'POST /api/setup': [201, { ...CREATED, command: 'curl x' }] });
    const user = userEvent.setup();
    render(<Setup onDone={() => {}} />);
    await fillFirstTwoSteps(user);
    await user.click(screen.getByRole('radio', { name: 'My subscription' }));
    await user.click(screen.getByRole('radio', { name: 'GLM' }));
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(calls[0]!.body).toMatchObject({ chief: { mode: 'personal', provider: 'glm' } });
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
