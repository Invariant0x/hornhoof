import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AcceptInvite } from '../src/screens/AcceptInvite';
import { mockApi } from './api-mock';

const INVITE = { companyName: 'Acme', name: 'Maria', email: 'maria@acme.com', title: 'Deputy CEO', scopeName: 'Whole company', scopeKind: 'company' };

describe('AcceptInvite', () => {
  it('offers to connect a subscription after the password, and Skip leads into the app', async () => {
    mockApi({ 'GET /api/invites/tok1': [200, INVITE], 'POST /api/invites/tok1/accept': [200, { person: {} }] });
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<AcceptInvite token="tok1" onDone={onDone} />);
    await user.type(await screen.findByLabelText('Choose a password'), 'long-enough-pass');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(await screen.findByRole('checkbox', { name: 'Claude' })).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('connects from the invite and goes on with Done', async () => {
    const calls = mockApi({
      'GET /api/invites/tok1': [200, INVITE],
      'POST /api/invites/tok1/accept': [200, { person: {} }],
      'POST /api/subscriptions/connect': [201, { subscriptions: [], command: 'curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join C' }],
    });
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<AcceptInvite token="tok1" onDone={onDone} />);
    await user.type(await screen.findByLabelText('Choose a password'), 'long-enough-pass');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Kimi' }));
    await user.click(screen.getByRole('button', { name: 'Get the command' }));
    expect(calls.find(c => c.path === '/api/subscriptions/connect')!.body).toEqual({ providers: ['kimi'] });
    await user.click(await screen.findByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledOnce();
  });
});
