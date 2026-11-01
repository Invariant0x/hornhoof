import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { People } from '../src/screens/People';
import type { PersonView } from '../src/types';
import { ME, mockApi, ORG_WITH_TEAMS, PEOPLE } from './api-mock';

const rowOf = (name: string) => screen.getByRole('row', { name: new RegExp(`^${name}\\b`) });

describe('People', () => {
  it('lists everyone with title, access and status', async () => {
    mockApi({ 'GET /api/people': [200, { people: PEOPLE }], 'GET /api/org': [200, ORG_WITH_TEAMS] });
    render(<People me={ME} />);
    expect(await screen.findByRole('cell', { name: 'Sasha' })).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map(h => h.textContent)).toEqual(['Name', 'Title', 'Access', 'Status', 'Actions']);
    expect(within(rowOf('Sasha')).getByText('Marketing / Social')).toBeInTheDocument();
    expect(within(rowOf('Sasha')).getByText('Invited')).toBeInTheDocument();
  });

  it('invites a person to two departments by checkboxes', async () => {
    const link = 'https://hq.acme.com/invite/TOKEN123';
    const calls = mockApi({
      'GET /api/people': [200, { people: PEOPLE }],
      'GET /api/org': [200, ORG_WITH_TEAMS],
      'POST /api/people/invite': [201, { person: PEOPLE[2], inviteUrl: link }],
    });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Invite person' }));
    const whole = screen.getByRole('checkbox', { name: 'Whole company' });
    expect(whole).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Marketing' })).not.toBeInTheDocument();
    await user.click(whole);
    await user.click(screen.getByRole('checkbox', { name: 'Development' }));
    await user.click(screen.getByRole('checkbox', { name: 'Marketing' }));
    /* A department includes its teams. */
    expect(screen.getByRole('checkbox', { name: 'Social' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Social' })).toBeDisabled();
    await user.type(screen.getByLabelText('Name'), 'Oleg');
    await user.type(screen.getByLabelText('Email'), 'oleg@acme.com');
    await user.click(screen.getByRole('button', { name: 'Send invite' }));
    expect(calls.find(c => c.method === 'POST')).toEqual({
      method: 'POST',
      path: '/api/people/invite',
      body: { name: 'Oleg', email: 'oleg@acme.com', title: '', access: { departments: ['d1', 'd2'], teams: [] } },
    });
    expect(await screen.findByText(link)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
  });

  it('will not send an empty list', async () => {
    const calls = mockApi({
      'GET /api/people': [200, { people: PEOPLE }],
      'GET /api/org': [200, ORG_WITH_TEAMS],
      'POST /api/people/invite': [201, { person: PEOPLE[2], inviteUrl: 'https://hq.acme.com/invite/T' }],
    });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Invite person' }));
    await user.type(screen.getByLabelText('Name'), 'Sasha');
    await user.type(screen.getByLabelText('Email'), 'sasha@acme.com');
    await user.click(screen.getByRole('checkbox', { name: 'Whole company' }));
    expect(screen.getByText('Tick at least one department or team.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send invite' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Social' }));
    await user.click(screen.getByRole('button', { name: 'Send invite' }));
    expect(calls.find(c => c.method === 'POST')?.body).toMatchObject({ access: { departments: [], teams: ['t1'] } });
  });

  it('warns next to the Operations tick that its head reads the whole company', async () => {
    const ops = { ...ORG_WITH_TEAMS.departments[1]!, id: 'd9', name: null, templateKey: 'operations' as const, roleCode: 'OPS' };
    mockApi({ 'GET /api/people': [200, { people: PEOPLE }], 'GET /api/org': [200, { ...ORG_WITH_TEAMS, departments: [...ORG_WITH_TEAMS.departments, ops] }] });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Invite person' }));
    await user.click(screen.getByRole('checkbox', { name: 'Whole company' }));
    const warning = /Operations reads all of Hornhoof's data/;
    expect(screen.getByRole('checkbox', { name: 'Operations' }).closest('li')).toHaveTextContent(warning);
    expect(screen.getByRole('checkbox', { name: 'Marketing' }).closest('li')).not.toHaveTextContent(warning);
  });

  it('shows what each person can reach', async () => {
    const oleg: PersonView = { ...PEOPLE[2]!, id: 'p4', name: 'Oleg', email: 'oleg@acme.com', title: 'Product lead', access: { whole: false, departments: [{ id: 'd1', name: 'Marketing' }, { id: 'd2', name: 'Development' }], teams: [] } };
    mockApi({ 'GET /api/people': [200, { people: [...PEOPLE, oleg] }], 'GET /api/org': [200, ORG_WITH_TEAMS] });
    render(<People me={ME} />);
    await screen.findByRole('cell', { name: 'Oleg' });
    expect(within(rowOf('Ivan')).getByText('Whole company')).toBeInTheDocument();
    expect(within(rowOf('Oleg')).getByText('Marketing, Development')).toBeInTheDocument();
    expect(within(rowOf('Sasha')).getByText('Marketing / Social')).toBeInTheDocument();
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
      expect(within(rowOf(name)).getAllByRole('button').map(b => b.textContent)).toEqual(['Edit']);
    }
    await user.click(within(rowOf('Sasha')).getByRole('button', { name: 'Disable Sasha' }));
    expect(calls.find(c => c.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/api/people/p3', body: { status: 'disabled' } });
  });

  it('hides invite and disable for people without company scope', async () => {
    mockApi({ 'GET /api/people': [200, { people: PEOPLE }], 'GET /api/org': [200, ORG_WITH_TEAMS] });
    const smm = { ...ME, person: { ...ME.person, id: 'p3', scopeKind: 'listed' as const, isOwner: false } };
    render(<People me={smm} />);
    await screen.findByRole('cell', { name: 'Sasha' });
    expect(screen.queryByRole('button', { name: 'Invite person' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Disable/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Sasha' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Ivan' })).not.toBeInTheDocument();
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

  it('lets you change your own title, and only the title', async () => {
    const calls = mockApi({
      'GET /api/people': [200, { people: PEOPLE }],
      'GET /api/org': [200, ORG_WITH_TEAMS],
      'PATCH /api/people/p1': [200, { person: { ...PEOPLE[0], title: 'Founder' } }],
    });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Edit Ivan' }));
    expect(screen.queryByRole('checkbox', { name: 'Whole company' })).not.toBeInTheDocument();
    const title = screen.getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Founder');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(calls.find(c => c.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/api/people/p1', body: { title: 'Founder' } });
    expect(await within(rowOf('Ivan')).findByRole('cell', { name: 'Founder' })).toBeInTheDocument();
  });

  it('edits title and access', async () => {
    const calls = mockApi({
      'GET /api/people': [200, { people: PEOPLE }],
      'GET /api/org': [200, ORG_WITH_TEAMS],
      'PATCH /api/people/p3': [200, { person: { ...PEOPLE[2], title: 'Head of social', access: { whole: false, departments: [{ id: 'd1', name: 'Marketing' }], teams: [] } } }],
    });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Edit Sasha' }));
    const title = screen.getByLabelText('Title');
    expect(title).toHaveValue('SMM');
    expect(screen.getByRole('checkbox', { name: 'Whole company' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Social' })).toBeChecked();
    await user.clear(title);
    await user.type(title, 'Head of social');
    await user.click(screen.getByRole('checkbox', { name: 'Marketing' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(calls.find(c => c.method === 'PATCH')).toEqual({
      method: 'PATCH',
      path: '/api/people/p3',
      body: { title: 'Head of social', access: { departments: ['d1'], teams: [] } },
    });
    expect(await screen.findByRole('cell', { name: 'Head of social' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
