import { render, screen } from '@testing-library/react';
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
    const calls = mockApi({ 'GET /api/invites/abc123': [200, { companyName: 'Acme', name: 'Maria', email: 'maria@acme.com', title: '', scopeName: 'Whole company' }] });
    render(<App />);
    expect(await screen.findByRole('heading', { name: /^Join/ })).toBeInTheDocument();
    expect(calls.map(c => c.path)).not.toContain('/api/me');
  });

  it('opens the workspace for a signed-in person', async () => {
    mockApi({ 'GET /api/setup': [200, { needed: false }], 'GET /api/me': [200, ME] });
    render(<App />);
    expect(await screen.findByText('Acme')).toBeInTheDocument();
  });
});
