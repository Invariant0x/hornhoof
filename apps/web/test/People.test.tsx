import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { People } from '../src/screens/People';
import { ME, mockApi, ORG_WITH_TEAMS, PEOPLE } from './api-mock';

const rowOf = (name: string) => screen.getByRole('row', { name: new RegExp(`^${name}\\b`) });

describe('People', () => {
  it('lists everyone with title, scope and status', async () => {
    mockApi({ 'GET /api/people': [200, { people: PEOPLE }], 'GET /api/org': [200, ORG_WITH_TEAMS] });
    render(<People me={ME} />);
    expect(await screen.findByRole('cell', { name: 'Sasha' })).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map(h => h.textContent)).toEqual(['Name', 'Title', 'Scope', 'Status', 'Actions']);
    expect(within(rowOf('Sasha')).getByText('Social')).toBeInTheDocument();
    expect(within(rowOf('Sasha')).getByText('Invited')).toBeInTheDocument();
  });

  it('invites a person to a team and shows the link once', async () => {
    const link = 'https://hq.acme.com/invite/TOKEN123';
    const calls = mockApi({
      'GET /api/people': [200, { people: PEOPLE }],
      'GET /api/org': [200, ORG_WITH_TEAMS],
      'POST /api/people/invite': [201, { person: PEOPLE[2], inviteUrl: link }],
    });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Invite person' }));
    const scope = screen.getByLabelText('Scope');
    expect(within(scope).getAllByRole('option').map(o => o.textContent)).toEqual(['Whole company', 'Marketing', 'Development', 'Marketing / Social', 'Marketing / Content']);
    await user.type(screen.getByLabelText('Name'), 'Sasha');
    await user.type(screen.getByLabelText('Email'), 'sasha@acme.com');
    await user.type(screen.getByLabelText('Title'), 'SMM');
    await user.selectOptions(scope, 'Marketing / Social');
    await user.click(screen.getByRole('button', { name: 'Send invite' }));
    expect(calls.find(c => c.method === 'POST')).toEqual({
      method: 'POST',
      path: '/api/people/invite',
      body: { name: 'Sasha', email: 'sasha@acme.com', title: 'SMM', scope: { kind: 'team', id: 't1' } },
    });
    expect(await screen.findByText(link)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
  });

  it('offers Disable on other rows but never on the owner or yourself', async () => {
    const calls = mockApi({
      'GET /api/people': [200, { people: PEOPLE }],
      'GET /api/org': [200, ORG_WITH_TEAMS],
      'PATCH /api/people/p3': [200, { person: { ...PEOPLE[2], status: 'disabled' } }],
    });
    const user = userEvent.setup();
    const maria = { ...ME, person: { ...ME.person, id: 'p2', name: 'Maria', isOwner: false } };
    render(<People me={maria} />);
    await screen.findByRole('cell', { name: 'Sasha' });
    for (const name of ['Ivan', 'Maria']) {
      expect(within(rowOf(name)).queryByRole('button')).not.toBeInTheDocument();
    }
    await user.click(within(rowOf('Sasha')).getByRole('button', { name: 'Disable Sasha' }));
    expect(calls.find(c => c.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/api/people/p3', body: { status: 'disabled' } });
  });

  it('hides invite and disable for people without company scope', async () => {
    mockApi({ 'GET /api/people': [200, { people: PEOPLE }], 'GET /api/org': [200, ORG_WITH_TEAMS] });
    const smm = { ...ME, person: { ...ME.person, id: 'p3', scopeKind: 'team' as const, scopeId: 't1', isOwner: false } };
    render(<People me={smm} />);
    await screen.findByRole('cell', { name: 'Sasha' });
    expect(screen.queryByRole('button', { name: 'Invite person' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Disable/ })).not.toBeInTheDocument();
  });
});

describe('People row actions', () => {
  it('sends a new invite link and shows it once', async () => {
    const link = 'https://hq.acme.com/invite/NEWTOKEN';
    const calls = mockApi({
      'GET /api/people': [200, { people: PEOPLE }],
      'GET /api/org': [200, ORG_WITH_TEAMS],
      'POST /api/people/p2/invite': [201, { person: { ...PEOPLE[1], status: 'invited' }, inviteUrl: link }],
    });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'New invite link for Maria' }));
    expect(calls.find(c => c.method === 'POST')).toEqual({ method: 'POST', path: '/api/people/p2/invite', body: undefined });
    expect(await screen.findByText(link)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Invite link for Maria' })).toBeInTheDocument();
    expect(within(rowOf('Maria')).getByText('Invited')).toBeInTheDocument();
  });

  it('edits title and scope', async () => {
    const calls = mockApi({
      'GET /api/people': [200, { people: PEOPLE }],
      'GET /api/org': [200, ORG_WITH_TEAMS],
      'PATCH /api/people/p3': [200, { person: { ...PEOPLE[2], title: 'Head of social', scope: { kind: 'department', id: 'd1', name: 'Marketing' } } }],
    });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Edit Sasha' }));
    const title = screen.getByLabelText('Title');
    expect(title).toHaveValue('SMM');
    expect(screen.getByLabelText('Scope')).toHaveDisplayValue('Marketing / Social');
    await user.clear(title);
    await user.type(title, 'Head of social');
    await user.selectOptions(screen.getByLabelText('Scope'), 'Marketing');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(calls.find(c => c.method === 'PATCH')).toEqual({
      method: 'PATCH',
      path: '/api/people/p3',
      body: { title: 'Head of social', scope: { kind: 'department', id: 'd1' } },
    });
    expect(await screen.findByRole('cell', { name: 'Head of social' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
