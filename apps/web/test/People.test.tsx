import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { ru } from '../src/i18n/ru';
import { People } from '../src/screens/People';
import type { Me, PersonView } from '../src/types';
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

  it('updates only your own row when your name changes outside this screen', async () => {
    mockApi({ 'GET /api/people': [200, { people: PEOPLE }], 'GET /api/org': [200, ORG_WITH_TEAMS] });
    const view = render(<People me={ME} />);
    await screen.findByRole('cell', { name: 'Ivan' });
    view.rerender(<People me={{ ...ME, person: { ...ME.person, name: 'Ivan K' } }} />);
    expect(screen.getByRole('cell', { name: 'Ivan K' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'Ivan' })).not.toBeInTheDocument();
    expect(within(rowOf('Maria')).getByRole('cell', { name: 'Deputy CEO' })).toBeInTheDocument();
    expect(within(rowOf('Sasha')).getByRole('cell', { name: 'SMM' })).toBeInTheDocument();
  });

  it('keeps the loaded names when your identity changes with the same name', async () => {
    const people = [{ ...PEOPLE[0]!, name: 'Ivan K' }, ...PEOPLE.slice(1)];
    mockApi({ 'GET /api/people': [200, { people }], 'GET /api/org': [200, ORG_WITH_TEAMS] });
    const view = render(<People me={ME} />);
    await screen.findByRole('cell', { name: 'Ivan K' });
    view.rerender(<People me={{ ...ME, person: { ...ME.person, id: 'p2' } }} />);
    expect(screen.getByRole('cell', { name: 'Ivan K' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'Ivan' })).not.toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Maria' })).toBeInTheDocument();
  });

  it('keeps the people request pending when your name changes before it loads', async () => {
    let finish!: (reply: [number, unknown]) => void;
    mockApi({
      'GET /api/people': () => new Promise(resolve => { finish = resolve; }),
      'GET /api/org': [200, ORG_WITH_TEAMS],
    });
    const view = render(<People me={ME} />);
    view.rerender(<People me={{ ...ME, person: { ...ME.person, name: 'Ivan K' } }} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    await act(async () => { finish([200, { people: PEOPLE }]); });
    expect(await screen.findByRole('cell', { name: 'Ivan' })).toBeInTheDocument();
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
  it('lets routed selection override a local edit and resets the draft only for another person', async () => {
    mockApi({ 'GET /api/people': [200, { people: PEOPLE }], 'GET /api/org': [200, ORG_WITH_TEAMS] });
    const view = render(<People me={ME} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit Maria' }));
    const title = screen.getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Maria draft');
    view.rerender(<People me={ME} selected="p2" />);
    expect(screen.getByLabelText('Title')).toBe(title);
    expect(title).toHaveValue('Maria draft');
    view.rerender(<People me={ME} selected={null} />);
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
    view.rerender(<People me={ME} selected="p3" />);
    expect(screen.getByRole('heading', { name: 'Edit Sasha' })).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('SMM');
  });

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

describe('the name in the edit form', () => {
  /* Who may rename whom, as the server's guard says: anyone their own, the CEO and the deputy with the whole company anyone's. */
  const DEPUTY: Me = { ...ME, person: { ...ME.person, id: 'p2', name: 'Maria', isOwner: false, isCeoDelegate: true } };
  const WHOLE_COMPANY: Me = { ...ME, person: { ...ME.person, id: 'p2', name: 'Maria', isOwner: false } };
  const LISTED: Me = { ...ME, person: { ...ME.person, id: 'p3', name: 'Sasha', isOwner: false, scopeKind: 'listed' } };

  const open = async (me: Me, who: string, routes: Parameters<typeof mockApi>[0] = {}, onRenamed?: (name: string) => void) => {
    const calls = mockApi({ 'GET /api/people': [200, { people: PEOPLE }], 'GET /api/org': [200, ORG_WITH_TEAMS], ...routes });
    const user = userEvent.setup();
    render(<People me={me} onRenamed={onRenamed} />);
    await user.click(await screen.findByRole('button', { name: `Edit ${who}` }));
    return { calls, user };
  };
  const retype = async (user: ReturnType<typeof userEvent.setup>, label: string, words: string) => {
    await user.clear(screen.getByLabelText(label));
    await user.type(screen.getByLabelText(label), words);
  };
  const patched = (calls: Awaited<ReturnType<typeof open>>['calls']) => calls.find(c => c.method === 'PATCH');

  afterEach(() => localStorage.clear());

  it('lets the CEO rename another person above the title, saves both together and shows the name in the list', async () => {
    const { calls, user } = await open(ME, 'Maria', { 'PATCH /api/people/p2': [200, { person: { ...PEOPLE[1], name: 'Maria Ray', title: 'COO' } }] });
    const name = screen.getByLabelText('Name');
    expect(name).toHaveValue('Maria');
    expect(name).toHaveFocus();
    expect(name.compareDocumentPosition(screen.getByLabelText('Title')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await retype(user, 'Name', '  Maria Ray  ');
    await retype(user, 'Title', 'COO');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(patched(calls)).toEqual({ method: 'PATCH', path: '/api/people/p2', body: { name: 'Maria Ray', title: 'COO', access: { whole: true } } });
    expect(await screen.findByRole('cell', { name: 'Maria Ray' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('lets the deputy with the whole company rename another person', async () => {
    const { calls, user } = await open(DEPUTY, 'Sasha', { 'PATCH /api/people/p3': [200, { person: { ...PEOPLE[2], name: 'Sasha Lee' } }] });
    await retype(user, 'Name', 'Sasha Lee');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(patched(calls)!.body).toMatchObject({ name: 'Sasha Lee' });
    expect(await screen.findByRole('cell', { name: 'Sasha Lee' })).toBeInTheDocument();
  });

  it('shows the deputy the field on the CEO too, as the server lets them, with nothing else to change', async () => {
    const { calls, user } = await open(DEPUTY, 'Ivan', { 'PATCH /api/people/p1': [200, { person: { ...PEOPLE[0], name: 'Ivan K' } }] });
    expect(screen.queryByRole('checkbox', { name: 'Whole company' })).not.toBeInTheDocument();
    await retype(user, 'Name', 'Ivan K');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(patched(calls)!.body).toEqual({ name: 'Ivan K', title: 'CEO' });
  });

  it('lets someone with a narrow reach change their own name, and tells the shell', async () => {
    const onRenamed = vi.fn();
    const { calls, user } = await open(LISTED, 'Sasha', { 'PATCH /api/people/p3': [200, { person: { ...PEOPLE[2], name: 'Sasha Lee' } }] }, onRenamed);
    await retype(user, 'Name', 'Sasha Lee');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(patched(calls)!.body).toEqual({ name: 'Sasha Lee', title: 'SMM' });
    expect(await screen.findByRole('cell', { name: 'Sasha Lee' })).toBeInTheDocument();
    expect(onRenamed).toHaveBeenCalledWith('Sasha Lee');
  });

  it('does not tell the shell when the name is someone else\'s', async () => {
    const onRenamed = vi.fn();
    const { user } = await open(ME, 'Maria', { 'PATCH /api/people/p2': [200, { person: { ...PEOPLE[1], name: 'Maria Ray' } }] }, onRenamed);
    await retype(user, 'Name', 'Maria Ray');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('cell', { name: 'Maria Ray' })).toBeInTheDocument();
    expect(onRenamed).not.toHaveBeenCalled();
  });

  it.each([['another person', 'Sasha', 'p3', 2], ['the CEO', 'Ivan', 'p1', 0]] as const)('hides the field from someone with the whole company on %s, whose title still saves', async (_who, name, id, row) => {
    const { calls, user } = await open(WHOLE_COMPANY, name, { [`PATCH /api/people/${id}`]: [200, { person: { ...PEOPLE[row]!, title: 'New title' } }] });
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveFocus();
    await retype(user, 'Title', 'New title');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(patched(calls)!.body).not.toHaveProperty('name');
    expect(patched(calls)!.body).toMatchObject({ title: 'New title' });
    expect(await screen.findByRole('cell', { name: 'New title' })).toBeInTheDocument();
  });

  it('hides the field from someone who may only look at another person', async () => {
    mockApi({ 'GET /api/people': [200, { people: PEOPLE }], 'GET /api/org': [200, ORG_WITH_TEAMS] });
    render(<People me={LISTED} selected="p2" onSelect={() => {}} />);
    expect(await screen.findByRole('heading', { name: 'Maria' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });

  it('sends the name only when it changed', async () => {
    const { calls, user } = await open(ME, 'Maria', { 'PATCH /api/people/p2': [200, { person: { ...PEOPLE[1], title: 'COO' } }] });
    await retype(user, 'Title', 'COO');
    await retype(user, 'Name', ' Maria ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(patched(calls)!.body).toEqual({ title: 'COO', access: { whole: true } });
  });

  it('will not save an empty name', async () => {
    const { user } = await open(ME, 'Maria');
    await user.clear(screen.getByLabelText('Name'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(screen.getByLabelText('Name'), '   ');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(screen.getByLabelText('Name'), 'M');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.getByLabelText('Name')).toHaveAttribute('maxlength', '80');
  });

  it('keeps the form and says why when the server refuses the name', async () => {
    const { user } = await open(ME, 'Maria', { 'PATCH /api/people/p2': [403, { error: { code: 'forbidden', message: 'Only the CEO or the CEO delegate changes another person\'s name.', reason: 'owner_locked' } }] });
    await retype(user, 'Name', 'Maria Ray');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Maria Ray');
    expect(within(rowOf('Maria')).queryByText('Maria Ray')).not.toBeInTheDocument();
  });

  it('labels the field in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    mockApi({ 'GET /api/people': [200, { people: PEOPLE }], 'GET /api/org': [200, ORG_WITH_TEAMS] });
    const user = userEvent.setup();
    render(<LanguageProvider><People me={ME} /></LanguageProvider>);
    await user.click(await screen.findByRole('button', { name: ru.people.editLabel('Maria') }));
    expect(screen.getByLabelText('Имя')).toHaveValue('Maria');
    expect(screen.getByLabelText('Должность')).toBeInTheDocument();
  });
});

describe('a person\'s Telegram in the edit form', () => {
  const open = async (me: Me, who: string, people: PersonView[], routes: Parameters<typeof mockApi>[0] = {}) => {
    const calls = mockApi({ 'GET /api/people': [200, { people }], 'GET /api/org': [200, ORG_WITH_TEAMS], ...routes });
    const user = userEvent.setup();
    render(<People me={me} />);
    await user.click(await screen.findByRole('button', { name: `Edit ${who}` }));
    return { calls, user };
  };

  it('lets you set your own Telegram, and sends it only when it changed', async () => {
    const { calls, user } = await open(ME, 'Ivan', PEOPLE, { 'PATCH /api/people/p1': [200, { person: { ...PEOPLE[0], telegram: { username: 'ivan_k', id: null } } }] });
    const field = screen.getByLabelText('Telegram');
    expect(field).toHaveValue('');
    expect(screen.getByText(/bots/, { selector: 'small, p, span' })).toBeInTheDocument();
    await user.type(field, '@Ivan_K');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(calls.find(c => c.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/api/people/p1', body: { title: 'CEO', telegram: '@Ivan_K' } });
  });

  it('shows the Telegram a person has and leaves it out of Save when untouched', async () => {
    const people = [PEOPLE[0]!, { ...PEOPLE[1]!, telegram: { username: 'maria_r', id: 5550002 } }, PEOPLE[2]!];
    const { calls, user } = await open(ME, 'Maria', people, { 'PATCH /api/people/p2': [200, { person: people[1] }] });
    expect(screen.getByLabelText('Telegram')).toHaveValue('@maria_r');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(calls.find(c => c.method === 'PATCH')!.body).not.toHaveProperty('telegram');
  });

  it('clears it with an empty field', async () => {
    const people = [PEOPLE[0]!, { ...PEOPLE[1]!, telegram: { username: null, id: 5550002 } }, PEOPLE[2]!];
    const { calls, user } = await open(ME, 'Maria', people, { 'PATCH /api/people/p2': [200, { person: { ...people[1], telegram: null } }] });
    expect(screen.getByLabelText('Telegram')).toHaveValue('5550002');
    await user.clear(screen.getByLabelText('Telegram'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(calls.find(c => c.method === 'PATCH')!.body).toMatchObject({ telegram: '' });
  });

  it('is not offered on the CEO\'s row to someone else with the whole company', async () => {
    const maria: Me = { ...ME, person: { ...ME.person, id: 'p2', name: 'Maria', isOwner: false } };
    await open(maria, 'Ivan', PEOPLE);
    expect(screen.queryByLabelText('Telegram')).not.toBeInTheDocument();
  });

  it('is labelled in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    mockApi({ 'GET /api/people': [200, { people: PEOPLE }], 'GET /api/org': [200, ORG_WITH_TEAMS] });
    const user = userEvent.setup();
    render(<LanguageProvider><People me={ME} /></LanguageProvider>);
    await user.click(await screen.findByRole('button', { name: ru.people.editLabel('Ivan') }));
    expect(screen.getByLabelText('Telegram')).toBeInTheDocument();
    expect(screen.getByText(/боты/)).toBeInTheDocument();
    localStorage.clear();
  });
});
