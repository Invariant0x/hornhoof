import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AcceptInvite } from '../src/screens/AcceptInvite';
import { Login } from '../src/screens/Login';
import { ME, mockApi } from './api-mock';

const INVITE = { companyName: 'Acme', name: 'Maria', email: 'maria@acme.com', title: 'Deputy CEO', access: { whole: true, departments: [], teams: [] } };

describe('Login', () => {
  it('shows the server message when the password is wrong', async () => {
    mockApi({ 'POST /api/auth/login': [401, { error: { code: 'unauthorized', message: 'Wrong email or password.' } }] });
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<Login onDone={onDone} />);
    await user.type(screen.getByLabelText('Email'), 'ivan@acme.com');
    await user.type(screen.getByLabelText('Password'), 'not the password');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('Wrong email or password.')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('signs in and moves on', async () => {
    const calls = mockApi({ 'POST /api/auth/login': [200, { person: ME.person }] });
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<Login onDone={onDone} />);
    await user.type(screen.getByLabelText('Email'), 'ivan@acme.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(calls[0]).toEqual({ method: 'POST', path: '/api/auth/login', body: { email: 'ivan@acme.com', password: 'correct horse battery' } });
    expect(onDone).toHaveBeenCalled();
  });
});

describe('AcceptInvite', () => {
  it('shows who invited you and joins with a new password', async () => {
    const calls = mockApi({ 'GET /api/invites/tok1': [200, INVITE], 'POST /api/invites/tok1/accept': [200, { person: ME.person }] });
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<AcceptInvite token="tok1" onDone={onDone} />);
    expect(await screen.findByRole('heading', { name: 'Join Acme' })).toBeInTheDocument();
    expect(screen.getByText('Deputy CEO, Whole company')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Choose a password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(screen.getByText('Use at least 10 characters.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Choose a password'), ' but longer now');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(calls.at(-1)).toEqual({ method: 'POST', path: '/api/invites/tok1/accept', body: { password: 'short but longer now' } });
    /* Next comes the connect step, see AcceptInvite.test.tsx. */
    expect(await screen.findByRole('button', { name: 'Skip for now' })).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('explains an expired or used invite', async () => {
    mockApi({ 'GET /api/invites/old': [410, { error: { code: 'gone', message: 'This invite has already been used or has expired. Ask for a new one.' } }] });
    render(<AcceptInvite token="old" onDone={() => {}} />);
    expect(await screen.findByText('This invite link was already used or has expired. If you joined with it, sign in with your email and password. If not, ask for a new one.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join' })).not.toBeInTheDocument();
  });

  it('explains an unknown invite', async () => {
    mockApi({});
    render(<AcceptInvite token="nope" onDone={() => {}} />);
    expect(await screen.findByText('This invite link is not valid. Check that you copied all of it, or ask for a new one.')).toBeInTheDocument();
  });
});
