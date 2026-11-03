import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { ME, mockApi, signedOut } from './api-mock';

describe('App', () => {
  it('opens setup when no company exists', async () => {
    mockApi({ 'GET /api/setup': [200, { needed: true }] });
    render(<App />);
    expect(await screen.findByText('Set up your company')).toBeInTheDocument();
  });

  it('opens log in when there is no session', async () => {
    mockApi({ 'GET /api/setup': [200, { needed: false }], 'GET /api/me': [401, signedOut] });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument();
  });

  it('opens the invite screen on an invite link without checking the session', async () => {
    window.history.replaceState(null, '', '/invite/abc123');
    const calls = mockApi({ 'GET /api/invites/abc123': [200, { companyName: 'Acme', name: 'Maria', email: 'maria@acme.com', title: '', access: { whole: true, departments: [], teams: [] } }] });
    render(<App />);
    expect(await screen.findByRole('heading', { name: /^Join/ })).toBeInTheDocument();
    expect(calls.map(c => c.path)).not.toContain('/api/me');
  });

  it('shows the version and build in a corner on every screen, login too', async () => {
    mockApi({ 'GET /api/setup': [200, { needed: false }], 'GET /api/me': [401, signedOut], 'GET /api/version': [200, { version: '0.4.0', commit: 'abc1234def', migrations: 5 }] });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument();
    expect(await screen.findByText('0.4.0 (abc1234)')).toHaveClass('version-mark');
  });

  it('opens the workspace once the person logs in', async () => {
    let signedIn = false;
    mockApi({
      'GET /api/setup': [200, { needed: false }],
      'GET /api/me': () => (signedIn ? [200, ME] : [401, signedOut]),
      'POST /api/auth/login': () => ((signedIn = true), [200, { person: ME.person }]),
    });
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText('Email'), 'ivan@acme.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('Acme')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Log in' })).not.toBeInTheDocument();
  });

  it('opens the workspace when a person who joined from an invite skips connecting a subscription', async () => {
    window.history.replaceState(null, '', '/invite/tok1');
    mockApi({
      'GET /api/invites/tok1': [200, { companyName: 'Acme', name: 'Maria', email: 'maria@acme.com', title: '', access: { whole: true, departments: [], teams: [] } }],
      'POST /api/invites/tok1/accept': [200, { person: ME.person }],
      'GET /api/setup': [200, { needed: false }],
      'GET /api/me': [200, ME],
    });
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText('Choose a password'), 'long-enough-pass');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    await user.click(await screen.findByRole('button', { name: 'Skip for now' }));
    expect(await screen.findByText('Acme')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip for now' })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
  });

  it('opens the workspace for a signed-in person', async () => {
    mockApi({ 'GET /api/setup': [200, { needed: false }], 'GET /api/me': [200, ME] });
    render(<App />);
    expect(await screen.findByText('Acme')).toBeInTheDocument();
  });
});
