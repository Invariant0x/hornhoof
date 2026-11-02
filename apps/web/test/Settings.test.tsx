import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Settings } from '../src/screens/Settings';
import { Shell } from '../src/screens/Shell';
import { ME, mockApi, ORG } from './api-mock';

const ACME = { name: 'acme', url: 'https://acme.hornhoof.org' };

describe('Settings', () => {
  it('shows the public link with a copy button', async () => {
    mockApi({ 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }] });
    render(<Settings me={ME} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(within(dialog).getByText('Hornhoof opens from anywhere at this link:')).toBeInTheDocument();
    expect(await within(dialog).findByRole('link', { name: 'https://acme.hornhoof.org' })).toHaveAttribute('href', 'https://acme.hornhoof.org');
    expect(within(dialog).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('moves the link to another name once the name is free', async () => {
    const calls = mockApi({
      'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }],
      'GET /api/link/names/acme-corp': [200, { name: 'acme-corp', free: true }],
      'PUT /api/link': [200, { link: { name: 'acme-corp', url: 'https://acme-corp.hornhoof.org' } }],
    });
    const user = userEvent.setup();
    render(<Settings me={ME} onClose={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Change name' }));
    expect(screen.getByLabelText('Link')).toHaveValue('acme');
    expect(screen.getByText('Machines connected through the old link lose the connection. Connect them again under Subscriptions or Machines.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Link'));
    await user.type(screen.getByLabelText('Link'), 'acme-corp');
    expect(await screen.findByText('acme-corp.hornhoof.org is free.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('link', { name: 'https://acme-corp.hornhoof.org' })).toBeInTheDocument();
    expect(calls.find(c => c.method === 'PUT')).toEqual({ method: 'PUT', path: '/api/link', body: { name: 'acme-corp' } });
  });

  it('removes the link after asking', async () => {
    const calls = mockApi({ 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }], 'DELETE /api/link': [204] });
    const user = userEvent.setup();
    render(<Settings me={ME} onClose={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Remove link' }));
    expect(screen.getByText('Hornhoof stops opening at https://acme.hornhoof.org. Machines connected through this link lose the connection.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Hornhoof opens only at its own address, on this computer and your network.')).toBeInTheDocument();
    expect(calls.map(c => `${c.method} ${c.path}`)).toContain('DELETE /api/link');
  });

  it('opens Hornhoof on the internet at a name made from the company name', async () => {
    const calls = mockApi({
      'GET /api/link': [200, { link: null, domain: 'hornhoof.org' }],
      'GET /api/link/names/acme': [200, { name: 'acme', free: true }],
      'PUT /api/link': [200, { link: ACME }],
    });
    const user = userEvent.setup();
    render(<Settings me={ME} onClose={() => {}} />);
    expect(await screen.findByText('Hornhoof opens only at its own address, on this computer and your network.')).toBeInTheDocument();
    expect(screen.getByLabelText('Link')).toHaveValue('acme');
    expect(screen.getByText(/A name like this is easy to guess/)).toBeInTheDocument();
    await screen.findByText('acme.hornhoof.org is free.');
    await user.click(screen.getByRole('button', { name: 'Open on the internet' }));
    expect(await screen.findByRole('link', { name: 'https://acme.hornhoof.org' })).toBeInTheDocument();
    expect(calls.find(c => c.method === 'PUT')!.body).toEqual({ name: 'acme' });
  });

  it('says why a name was refused', async () => {
    mockApi({
      'GET /api/link': [200, { link: null, domain: 'hornhoof.org' }],
      'PUT /api/link': [409, { error: { code: 'conflict', message: 'This link is taken already. Pick another name.', reason: 'link_taken' } }],
    });
    const user = userEvent.setup();
    render(<Settings me={ME} onClose={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Open on the internet' }));
    expect(await screen.findByText('This link is taken already. Pick another name.')).toBeInTheDocument();
  });
});

describe('Settings in the account menu', () => {
  it('opens for people who see the whole company', async () => {
    mockApi({ 'GET /api/org': [200, ORG], 'GET /api/link': [200, { link: ACME, domain: 'hornhoof.org' }] });
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
  });

  it('is not there for people who see only some departments', async () => {
    mockApi({ 'GET /api/org': [200, ORG] });
    const user = userEvent.setup();
    render(<Shell me={{ ...ME, person: { ...ME.person, scopeKind: 'listed' } }} onSignOut={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
  });
});
