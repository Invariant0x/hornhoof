import { act, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { ru } from '../src/i18n/ru';
import { AgentWindowContext } from '../src/screens/AgentWindowContext';
import { People } from '../src/screens/People';
import { AgentIcon, PersonIcon } from '../src/ui/icons';
import type { Me, PersonView, SubView } from '../src/types';
import { ME, mockApi, ORG_WITH_TEAMS, PEOPLE, SUBS } from './api-mock';
import { decl } from './css';

/* The icon a heading or a choice card shows, and how an icon is drawn on its own, to tell the person from the agent. */
const iconOf = (element: HTMLElement) => element.querySelector('svg')!.outerHTML;
const drawn = (icon: ReactElement) => render(icon).container.innerHTML;

const rowOf = (name: string) => screen.getByRole('row', { name: new RegExp(`^${name}\\b`) });
/* The first button of a confirmation is its action, named by its verb. */
const confirm = (user: ReturnType<typeof userEvent.setup>) => user.click(within(screen.getByRole('alertdialog')).getAllByRole('button')[0]);

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
    view.rerender(<People me={{ ...ME, person: { ...ME.person, name: 'Ivan R' } }} />);
    expect(screen.getByRole('cell', { name: 'Ivan R' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'Ivan' })).not.toBeInTheDocument();
    expect(within(rowOf('Maria')).getByRole('cell', { name: 'Deputy CEO' })).toBeInTheDocument();
    expect(within(rowOf('Sasha')).getByRole('cell', { name: 'SMM' })).toBeInTheDocument();
  });

  it('keeps the loaded names when your identity changes with the same name', async () => {
    const people = [{ ...PEOPLE[0]!, name: 'Ivan R' }, ...PEOPLE.slice(1)];
    mockApi({ 'GET /api/people': [200, { people }], 'GET /api/org': [200, ORG_WITH_TEAMS] });
    const view = render(<People me={ME} />);
    await screen.findByRole('cell', { name: 'Ivan R' });
    view.rerender(<People me={{ ...ME, person: { ...ME.person, id: 'p2' } }} />);
    expect(screen.getByRole('cell', { name: 'Ivan R' })).toBeInTheDocument();
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
    view.rerender(<People me={{ ...ME, person: { ...ME.person, name: 'Ivan R' } }} />);
    expect(screen.getByRole('table').closest('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByRole('cell', { name: 'Ivan' })).not.toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: 'Create invite link' }));
    expect(calls.find(c => c.method === 'POST')).toEqual({
      method: 'POST',
      path: '/api/people/invite',
      body: { name: 'Oleg', email: 'oleg@acme.com', title: '', access: { departments: ['d1', 'd2'], teams: [] } },
    });
    expect(await screen.findByText(link)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Create invite link' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Social' }));
    await user.click(screen.getByRole('button', { name: 'Create invite link' }));
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
    expect(calls.some(c => c.method === 'PATCH')).toBe(false);
    await confirm(user);
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

describe('deleting a person', () => {
  const AVA: PersonView = {
    id: 'h1', name: 'Ava', email: null, title: '', status: 'active', isOwner: false, access: { whole: false, departments: [], teams: [] },
    assistant: { owner: { id: 'p1', name: 'Ivan' }, program: 'avaclone', eventsUrl: null, skillsUrl: null, key: null, agent: null },
  };
  const lists = { 'GET /api/people': [200, { people: [...PEOPLE, AVA] }] as [number, unknown], 'GET /api/org': [200, ORG_WITH_TEAMS] as [number, unknown] };
  const MARIA: Me = { ...ME, person: { ...ME.person, id: 'p2', name: 'Maria', isOwner: false } };

  it("offers the CEO Delete on everyone's row but the CEO's own, a person or an assistant", async () => {
    mockApi(lists);
    render(<People me={ME} />);
    await screen.findByRole('cell', { name: 'Sasha' });
    expect(within(rowOf('Ivan')).queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();
    for (const name of ['Maria', 'Sasha', 'Ava']) expect(within(rowOf(name)).getByRole('button', { name: `Delete ${name}` })).toHaveTextContent('Delete');
  });

  it('is not offered to anyone but the CEO, even the deputy with the whole company', async () => {
    mockApi(lists);
    render(<People me={MARIA} />);
    await screen.findByRole('cell', { name: 'Sasha' });
    expect(screen.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();
  });

  it('asks once, in one dialog that says it cannot be undone, then deletes and takes the row away', async () => {
    const calls = mockApi({ ...lists, 'DELETE /api/people/p3': [204, undefined] });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Delete Sasha' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Do you really want to delete this person?' });
    expect(dialog).toHaveAccessibleDescription('Sasha will be deleted from the company.');
    expect(dialog).toHaveTextContent(/stop working.*This cannot be undone\./);
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toHaveClass('danger');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(calls.some(c => c.method === 'DELETE')).toBe(false);
    await confirm(user);
    expect(calls.filter(c => c.method === 'DELETE')).toEqual([{ method: 'DELETE', path: '/api/people/p3', body: undefined }]);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'Sasha' })).not.toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Maria' })).toBeInTheDocument();
  });

  it("says what goes with an assistant: its key and its own agent", async () => {
    mockApi(lists);
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Delete Ava' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Do you really want to delete this assistant?' });
    expect(dialog).toHaveAccessibleDescription('Ava will be deleted from the company.');
    expect(dialog).toHaveTextContent(/key stops working and its own agent leaves the company/);
  });

  it('leaves the person as they are on Cancel or Escape', async () => {
    const calls = mockApi({ ...lists, 'DELETE /api/people/p2': [204, undefined] });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Delete Maria' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete Maria' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(calls.some(c => c.method === 'DELETE')).toBe(false);
    expect(screen.getByRole('cell', { name: 'Maria' })).toBeInTheDocument();
  });

  it("closes the person's open card with them, and not someone else's", async () => {
    mockApi({ ...lists, 'DELETE /api/people/p3': [204, undefined], 'DELETE /api/people/p2': [204, undefined] });
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<People me={ME} selected="p3" onSelect={onSelect} />);
    await user.click(await screen.findByRole('button', { name: 'Delete Maria' }));
    await confirm(user);
    expect(screen.queryByRole('cell', { name: 'Maria' })).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete Sasha' }));
    await confirm(user);
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("keeps the row and shows why when the server refuses, as for a person whose machine runs the company's server", async () => {
    const leader = { error: { code: 'conflict', reason: 'leader', message: 'maria-box runs the company server. Move the server to another machine first.' } };
    mockApi({ ...lists, 'DELETE /api/people/p2': [409, leader] });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Delete Maria' }));
    await confirm(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('maria-box runs the company server');
    expect(screen.getByRole('cell', { name: 'Maria' })).toBeInTheDocument();
  });

  it('asks in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    mockApi(lists);
    const user = userEvent.setup();
    render(<LanguageProvider><People me={ME} /></LanguageProvider>);
    await user.click(await screen.findByRole('button', { name: 'Удалить Sasha' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Вы действительно хотите удалить этого человека?' });
    expect(dialog).toHaveAccessibleDescription('Учетная запись Sasha будет удалена из компании.');
    expect(dialog).toHaveTextContent(/Это нельзя отменить\./);
    expect(within(dialog).getByRole('button', { name: 'Удалить' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: ru.common.cancel })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Удалить Ava' }));
    expect(screen.getByRole('alertdialog', { name: 'Вы действительно хотите удалить этого помощника?' })).toHaveTextContent(/Помощник Ava будет удален из компании\..*ключ перестанет работать/);
    localStorage.clear();
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
    expect(screen.getByRole('heading', { name: 'Invite link for Maria is ready' })).toBeInTheDocument();
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
    await confirm(user);
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
    await confirm(user);
    expect(patched(calls)).toEqual({ method: 'PATCH', path: '/api/people/p2', body: { name: 'Maria Ray', title: 'COO', access: { whole: true } } });
    expect(await screen.findByRole('cell', { name: 'Maria Ray' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('lets the deputy with the whole company rename another person', async () => {
    const { calls, user } = await open(DEPUTY, 'Sasha', { 'PATCH /api/people/p3': [200, { person: { ...PEOPLE[2], name: 'Sasha Lee' } }] });
    await retype(user, 'Name', 'Sasha Lee');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await confirm(user);
    expect(patched(calls)!.body).toMatchObject({ name: 'Sasha Lee' });
    expect(await screen.findByRole('cell', { name: 'Sasha Lee' })).toBeInTheDocument();
  });

  it('shows the deputy the field on the CEO too, as the server lets them, with nothing else to change', async () => {
    const { calls, user } = await open(DEPUTY, 'Ivan', { 'PATCH /api/people/p1': [200, { person: { ...PEOPLE[0], name: 'Ivan R' } }] });
    expect(screen.queryByRole('checkbox', { name: 'Whole company' })).not.toBeInTheDocument();
    await retype(user, 'Name', 'Ivan R');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await confirm(user);
    expect(patched(calls)!.body).toEqual({ name: 'Ivan R', title: 'CEO' });
  });

  it('lets someone with a narrow reach change their own name, and tells the shell', async () => {
    const onRenamed = vi.fn();
    const { calls, user } = await open(LISTED, 'Sasha', { 'PATCH /api/people/p3': [200, { person: { ...PEOPLE[2], name: 'Sasha Lee' } }] }, onRenamed);
    await retype(user, 'Name', 'Sasha Lee');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await confirm(user);
    expect(patched(calls)!.body).toEqual({ name: 'Sasha Lee', title: 'SMM' });
    expect(await screen.findByRole('cell', { name: 'Sasha Lee' })).toBeInTheDocument();
    expect(onRenamed).toHaveBeenCalledWith('Sasha Lee');
  });

  it('does not tell the shell when the name is someone else\'s', async () => {
    const onRenamed = vi.fn();
    const { user } = await open(ME, 'Maria', { 'PATCH /api/people/p2': [200, { person: { ...PEOPLE[1], name: 'Maria Ray' } }] }, onRenamed);
    await retype(user, 'Name', 'Maria Ray');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await confirm(user);
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
    await confirm(user);
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
    const { calls, user } = await open(ME, 'Ivan', PEOPLE, { 'PATCH /api/people/p1': [200, { person: { ...PEOPLE[0], telegram: { username: 'ivan_ops', id: null } } }] });
    const field = screen.getByLabelText('Telegram');
    expect(field).toHaveValue('');
    expect(screen.getByText(/bots/, { selector: 'small, p, span' })).toBeInTheDocument();
    await user.type(field, '@ivan_ops');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(calls.find(c => c.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/api/people/p1', body: { title: 'CEO', telegram: '@ivan_ops' } });
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

describe("a person's assistant", () => {
  const AVA: PersonView = {
    id: 'h1', name: 'Ava', email: null, title: '', status: 'active', isOwner: false, access: { whole: false, departments: [], teams: [] },
    assistant: { owner: { id: 'p2', name: 'Maria' }, program: 'avaclone', eventsUrl: null, skillsUrl: null, key: null, agent: null },
  };
  const KEYED: PersonView = { ...AVA, assistant: { ...AVA.assistant!, key: { createdAt: '2026-11-11T10:00:00.000Z' } } };
  /* Sasha, active, sees only the Social team. */
  const SASHA: Me = { ...ME, person: { ...ME.person, id: 'p3', name: 'Sasha', email: 'sasha@acme.com', isOwner: false, scopeKind: 'listed' } };
  const ACTIVE = PEOPLE.map(p => (p.id === 'p3' ? { ...p, status: 'active' as const } : p));
  const lists = (people: PersonView[]) => ({ 'GET /api/people': [200, { people }] as [number, unknown], 'GET /api/org': [200, ORG_WITH_TEAMS] as [number, unknown] });

  it("is listed as an agent with its owner, reaching what the owner reaches, and gets no invite link", async () => {
    mockApi(lists([...PEOPLE, AVA]));
    render(<People me={ME} />);
    await screen.findByText('Assistant of Maria');
    const row = rowOf('Ava');
    expect(within(row).getByText('Assistant of Maria')).toBeInTheDocument();
    expect(within(row).getByText('Same as Maria')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'New invite link for Ava' })).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Disable Ava' })).toBeInTheDocument();
  });

  it('is added for a person with its program and events address, and its card opens to make a key', async () => {
    const calls = mockApi({ ...lists(PEOPLE), 'POST /api/people/assistants': [201, { person: AVA }] });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Invite person' }));
    await user.click(screen.getByRole('radio', { name: 'Personal AI assistant' }));
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Whole company' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('option', { name: /Ivan|Maria|Sasha/ }).map(o => o.textContent)).toEqual(['Ivan', 'Maria']);
    await user.type(screen.getByLabelText('Assistant name'), 'Ava');
    await user.selectOptions(screen.getByLabelText('Owner'), 'Maria');
    await user.selectOptions(screen.getByLabelText('Program'), 'OpenClaw');
    await user.type(screen.getByLabelText(/Events address/), 'https://ava.example.com/hornhoof');
    await user.click(screen.getByRole('button', { name: 'Create assistant' }));
    expect(calls.find(c => c.method === 'POST')).toEqual({
      method: 'POST', path: '/api/people/assistants',
      body: { name: 'Ava', title: '', owner: 'p2', program: 'openclaw', eventsUrl: 'https://ava.example.com/hornhoof' },
    });
    expect(await screen.findByRole('button', { name: 'Issue key' })).toBeInTheDocument();
    expect(within(rowOf('Ava')).getByText('Assistant of Maria')).toBeInTheDocument();
  });

  it('makes a key and shows it with the signing secret once, then replaces and revokes it', async () => {
    const calls = mockApi({
      ...lists([...PEOPLE, AVA]),
      'POST /api/people/h1/key': [201, { key: 'hha_KEY', signingSecret: 'hhs_SECRET', person: KEYED }],
      'DELETE /api/people/h1/key': [200, { person: AVA }],
    });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Edit Ava' }));
    expect(screen.getByText('No key yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Issue key' }));
    expect(await screen.findByText('hha_KEY')).toBeInTheDocument();
    expect(screen.getByText('hhs_SECRET')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy key' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy signing secret' })).toBeInTheDocument();
    expect(screen.getByText('Copy the key and the signing secret now: they are shown only once.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide key' }));
    expect(screen.queryByText('hha_KEY')).not.toBeInTheDocument();
    expect(screen.getByText(/^Key made on/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace key' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revoke key' }));
    expect(await screen.findByText('No key yet.')).toBeInTheDocument();
    expect(calls.filter(c => c.path === '/api/people/h1/key').map(c => c.method)).toEqual(['POST', 'DELETE']);
  });

  it.each([
    ['en', 'Edit Ava', 'Issue key', 'Copy for the assistant', 'Connect to my company in Hornhoof.\nAddress: https://acme.hornhoof.app\nKey: hha_KEY'],
    ['ru', 'Изменить Ava', 'Выпустить ключ', 'Скопировать для ассистента', 'Подключись к моей компании в Hornhoof.\nАдрес: https://acme.hornhoof.app\nКлюч: hha_KEY'],
  ])("copies the company's address and the key as one text for the assistant, without the signing secret, in %s", async (language, edit, create, button, text) => {
    localStorage.setItem('hh-lang', language);
    mockApi({ ...lists([...PEOPLE, AVA]), 'POST /api/people/h1/key': [201, { key: 'hha_KEY', signingSecret: 'hhs_SECRET', address: 'https://acme.hornhoof.app', person: KEYED }] });
    const user = userEvent.setup();
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn((t: string) => { copied.push(t); return Promise.resolve(); }) } });
    render(<LanguageProvider><People me={ME} /></LanguageProvider>);
    await user.click(await screen.findByRole('button', { name: edit }));
    await user.click(screen.getByRole('button', { name: create }));
    await user.click(await screen.findByRole('button', { name: button }));
    expect(copied).toEqual([text]);
    localStorage.clear();
  });

  it.each([
    ['en', 'Edit Ava', 'AvaClone'],
    ['ru', 'Изменить Ava', 'AvaClone'],
  ])('names the AvaClone program in %s', async (language, edit, option) => {
    localStorage.setItem('hh-lang', language);
    try {
      mockApi(lists([...PEOPLE, AVA]));
      const user = userEvent.setup();
      render(<LanguageProvider><People me={ME} /></LanguageProvider>);
      await user.click(await screen.findByRole('button', { name: edit }));
      expect(screen.getByRole('option', { name: option })).toHaveValue('avaclone');
    } finally {
      localStorage.clear();
    }
  });

  it.each([
    ['en', 'Edit Ava', 'Issue key', 'Copy for the assistant', 'Connect to my company in Hornhoof.\nAddress: https://acme.hornhoof.app\nKey: hha_KEY\nSecret: hhs_SECRET'],
    ['ru', 'Изменить Ava', 'Выпустить ключ', 'Скопировать для ассистента', 'Подключись к моей компании в Hornhoof.\nАдрес: https://acme.hornhoof.app\nКлюч: hha_KEY\nСекрет: hhs_SECRET'],
  ])('adds the signing secret to the text for a compatible assistant that has an address to be called at, in %s', async (language, edit, create, button, text) => {
    localStorage.setItem('hh-lang', language);
    const called: PersonView = { ...KEYED, assistant: { ...KEYED.assistant!, skillsUrl: 'https://ava.example.com/skills' } };
    mockApi({ ...lists([...PEOPLE, AVA]), 'POST /api/people/h1/key': [201, { key: 'hha_KEY', signingSecret: 'hhs_SECRET', address: 'https://acme.hornhoof.app', person: called }] });
    const user = userEvent.setup();
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn((t: string) => { copied.push(t); return Promise.resolve(); }) } });
    render(<LanguageProvider><People me={ME} /></LanguageProvider>);
    await user.click(await screen.findByRole('button', { name: edit }));
    await user.click(screen.getByRole('button', { name: create }));
    await user.click(await screen.findByRole('button', { name: button }));
    expect(copied).toEqual([text]);
    localStorage.clear();
  });

  it('keeps the signing secret out of the text for another program, even with an events address', async () => {
    const claw: PersonView = { ...KEYED, assistant: { ...KEYED.assistant!, program: 'other', eventsUrl: 'https://ava.example.com/h' } };
    mockApi({ ...lists([...PEOPLE, AVA]), 'POST /api/people/h1/key': [201, { key: 'hha_KEY', signingSecret: 'hhs_SECRET', address: 'https://acme.hornhoof.app', person: claw }] });
    const user = userEvent.setup();
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn((t: string) => { copied.push(t); return Promise.resolve(); }) } });
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Edit Ava' }));
    await user.click(screen.getByRole('button', { name: 'Issue key' }));
    await user.click(await screen.findByRole('button', { name: 'Copy for the assistant' }));
    expect(copied).toEqual(['Connect to my company in Hornhoof.\nAddress: https://acme.hornhoof.app\nKey: hha_KEY']);
  });

  describe('its own agent', () => {
    const MARIA: Me = { ...ME, person: { ...ME.person, id: 'p2', name: 'Maria', email: 'maria@acme.com', isOwner: false } };
    const PLANS: SubView[] = [
      SUBS[0]!,
      { ...SUBS[0]!, id: 's-maria', label: 'Claude', owner: { id: 'p2', name: 'Maria' } },
      { ...SUBS[3]!, owner: { id: 'p2', name: 'Maria' } },
    ];

    it("lets its owner pick the plan it thinks on, among the owner's own plans only", async () => {
      const calls = mockApi({ ...lists([...PEOPLE, AVA]), 'GET /api/subscriptions': [200, { subscriptions: PLANS }], 'PATCH /api/people/h1/assistant': [200, { person: AVA }] });
      const user = userEvent.setup();
      render(<People me={MARIA} />);
      await user.click(await screen.findByRole('button', { name: 'Edit Ava' }));
      const plan = await screen.findByLabelText('Plan it thinks on');
      expect(within(plan).getAllByRole('option').map(o => o.getAttribute('value'))).toEqual(['', 's-maria']);
      expect(screen.queryByRole('button', { name: 'Open its agent' })).not.toBeInTheDocument();
      await user.selectOptions(plan, 's-maria');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(calls.find(c => c.method === 'PATCH')!.body).toEqual({ program: 'avaclone', eventsUrl: null, skillsUrl: null, plan: 's-maria' });
    });

    it('sends no plan when the owner left it as it was, and opens the agent from the card', async () => {
      const thinking: PersonView = { ...AVA, assistant: { ...AVA.assistant!, agent: { id: 'a9', plan: 's-maria' } } };
      const calls = mockApi({ ...lists([...PEOPLE, thinking]), 'GET /api/subscriptions': [200, { subscriptions: PLANS }], 'PATCH /api/people/h1/assistant': [200, { person: thinking }] });
      const user = userEvent.setup();
      const open = vi.fn();
      render(<AgentWindowContext.Provider value={open}><People me={MARIA} /></AgentWindowContext.Provider>);
      await user.click(await screen.findByRole('button', { name: 'Edit Ava' }));
      expect(await screen.findByLabelText('Plan it thinks on')).toHaveValue('s-maria');
      await user.click(screen.getByRole('button', { name: 'Open its agent' }));
      expect(open).toHaveBeenCalledWith('a9');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(calls.find(c => c.method === 'PATCH')!.body).toEqual({ program: 'avaclone', eventsUrl: null, skillsUrl: null });
    });

    it('says the owner has no plan of their own yet', async () => {
      mockApi({ ...lists([...PEOPLE, AVA]), 'GET /api/subscriptions': [200, { subscriptions: [SUBS[0]!] }] });
      const user = userEvent.setup();
      render(<People me={MARIA} />);
      await user.click(await screen.findByRole('button', { name: 'Edit Ava' }));
      expect(await screen.findByText(/You have no plan of your own yet/)).toBeInTheDocument();
    });

    it('is not shown to someone who looks after the assistant but is not its owner', async () => {
      const calls = mockApi(lists([...PEOPLE, AVA]));
      const user = userEvent.setup();
      render(<People me={ME} />);
      await user.click(await screen.findByRole('button', { name: 'Edit Ava' }));
      expect(screen.getByLabelText('Program')).toBeInTheDocument();
      expect(screen.queryByLabelText('Plan it thinks on')).not.toBeInTheDocument();
      expect(calls.some(c => c.path === '/api/subscriptions')).toBe(false);
    });

    it('is offered in Russian', async () => {
      localStorage.setItem('hh-lang', 'ru');
      mockApi({ ...lists([...PEOPLE, AVA]), 'GET /api/subscriptions': [200, { subscriptions: PLANS }] });
      const user = userEvent.setup();
      render(<LanguageProvider><People me={MARIA} /></LanguageProvider>);
      await user.click(await screen.findByRole('button', { name: 'Изменить Ava' }));
      expect(await screen.findByLabelText('На какой подписке думает')).toBeInTheDocument();
      expect(screen.getByLabelText(/Адрес умений/)).toBeInTheDocument();
      localStorage.clear();
    });
  });

  it.each([
    ['en', 'Edit Ava', 'Issue key', 'Settings for OpenClaw', 'Add these lines to ~/.openclaw/openclaw.json', 'Copy settings'],
    ['ru', 'Изменить Ava', 'Выпустить ключ', 'Настройки для OpenClaw', 'Добавьте эти строки в ~/.openclaw/openclaw.json', 'Скопировать настройки'],
  ])('shows the settings that connect OpenClaw with a new key, and copies them whole, in %s', async (language, edit, create, heading, where, button) => {
    localStorage.setItem('hh-lang', language);
    const claw: PersonView = { ...KEYED, assistant: { ...KEYED.assistant!, program: 'openclaw' } };
    const setup = { file: '~/.openclaw/openclaw.json', text: '{\n  mcp: {\n    servers: { hornhoof: { url: "https://acme.hornhoof.app/api/assistant/mcp" } },\n  },\n}' };
    mockApi({ ...lists([...PEOPLE, { ...AVA, assistant: { ...AVA.assistant!, program: 'openclaw' } }]), 'POST /api/people/h1/key': [201, { key: 'hha_KEY', signingSecret: 'hhs_SECRET', address: 'https://acme.hornhoof.app', setup, person: claw }] });
    const user = userEvent.setup();
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn((t: string) => { copied.push(t); return Promise.resolve(); }) } });
    render(<LanguageProvider><People me={ME} /></LanguageProvider>);
    await user.click(await screen.findByRole('button', { name: edit }));
    await user.click(screen.getByRole('button', { name: create }));
    expect(await screen.findByText(heading)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(where.replace(/[.~/]/g, '\\$&')))).toBeInTheDocument();
    expect(screen.getByText(/servers: \{ hornhoof/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: button }));
    expect(copied).toEqual([setup.text]);
    localStorage.clear();
  });

  it('shows no settings for a program that takes the address and the key itself', async () => {
    mockApi({ ...lists([...PEOPLE, AVA]), 'POST /api/people/h1/key': [201, { key: 'hha_KEY', signingSecret: 'hhs_SECRET', address: 'https://acme.hornhoof.app', setup: null, person: KEYED }] });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Edit Ava' }));
    await user.click(screen.getByRole('button', { name: 'Issue key' }));
    expect(await screen.findByText('hha_KEY')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy settings' })).not.toBeInTheDocument();
  });

  it('says where OpenClaw and Hermes take their wakes, under the events address', async () => {
    mockApi({ ...lists([...PEOPLE, AVA]) });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Edit Ava' }));
    expect(screen.queryByText(/:18789\/hooks\/wake/)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Program'), 'OpenClaw');
    expect(screen.getByText(/http:\/\/192\.168\.1\.5:18789\/hooks\/wake/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Program'), 'Hermes Agent');
    expect(screen.getByText(/http:\/\/192\.168\.1\.5:8644\/webhooks\/hornhoof/)).toBeInTheDocument();
  });

  it('saves its program and events address, with its title for someone who manages people', async () => {
    const saved: PersonView = { ...AVA, title: 'Helper', assistant: { ...AVA.assistant!, program: 'other', eventsUrl: 'https://ava.example.com/h' } };
    const calls = mockApi({
      ...lists([...PEOPLE, AVA]),
      'PATCH /api/people/h1': [200, { person: { ...AVA, title: 'Helper' } }],
      'PATCH /api/people/h1/assistant': [200, { person: saved }],
    });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Edit Ava' }));
    expect(screen.getByText(/Acts for Maria, with the same rights/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Telegram')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Whole company' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Title'), 'Helper');
    await user.selectOptions(screen.getByLabelText('Program'), 'Other');
    await user.type(screen.getByLabelText(/Events address/), 'https://ava.example.com/h');
    await user.type(screen.getByLabelText(/Skills address/), 'https://ava.example.com/skills');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(calls.filter(c => c.method === 'PATCH')).toEqual([
      { method: 'PATCH', path: '/api/people/h1', body: { title: 'Helper' } },
      { method: 'PATCH', path: '/api/people/h1/assistant', body: { program: 'other', eventsUrl: 'https://ava.example.com/h', skillsUrl: 'https://ava.example.com/skills' } },
    ]);
    expect(await within(rowOf('Ava')).findByText('Helper')).toBeInTheDocument();
  });

  it("lets a person without the whole company add their own assistant and look after it, and nobody else's", async () => {
    const max: PersonView = { ...AVA, id: 'h2', name: 'Max', assistant: { ...AVA.assistant!, owner: { id: 'p3', name: 'Sasha' } } };
    const calls = mockApi({ ...lists([...ACTIVE, AVA]), 'POST /api/people/assistants': [201, { person: max }], 'PATCH /api/people/h2/assistant': [200, { person: max }] });
    const user = userEvent.setup();
    render(<People me={SASHA} />);
    await screen.findByText('Assistant of Maria');
    expect(screen.queryByRole('button', { name: 'Invite person' })).not.toBeInTheDocument();
    expect(within(rowOf('Ava')).queryByRole('button', { name: 'Edit Ava' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add my assistant' }));
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(iconOf(screen.getByRole('heading', { name: 'New personal AI assistant' }))).toBe(drawn(<AgentIcon />));
    expect(screen.queryByLabelText('Owner')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Assistant name'), 'Max');
    await user.click(screen.getByRole('button', { name: 'Create assistant' }));
    expect(calls.find(c => c.method === 'POST')!.body).toEqual({ name: 'Max', title: '', owner: 'p3', program: 'avaclone', eventsUrl: null });
    expect(await screen.findByRole('button', { name: 'Issue key' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(calls.filter(c => c.method === 'PATCH').map(c => c.path)).toEqual(['/api/people/h2/assistant']);
    expect(within(rowOf('Max')).getByRole('button', { name: 'Edit Max' })).toBeInTheDocument();
    expect(within(rowOf('Max')).queryByRole('button', { name: 'Disable Max' })).not.toBeInTheDocument();
  });

  it("leaves the CEO's assistant to the CEO, even for someone with the whole company", async () => {
    const ivans: PersonView = { ...AVA, id: 'h3', name: 'Iva', assistant: { ...AVA.assistant!, owner: { id: 'p1', name: 'Ivan' } } };
    const maria: Me = { ...ME, person: { ...ME.person, id: 'p2', name: 'Maria', isOwner: false } };
    mockApi(lists([...PEOPLE, ivans]));
    render(<People me={maria} />);
    await screen.findByText('Assistant of Ivan');
    expect(within(rowOf('Iva')).queryByRole('button', { name: 'Edit Iva' })).not.toBeInTheDocument();
  });

  it('is offered in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    mockApi(lists([...PEOPLE, AVA]));
    const user = userEvent.setup();
    render(<LanguageProvider><People me={ME} /></LanguageProvider>);
    expect(await screen.findByText(ru.people.assistantOf('Maria'))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: ru.people.invitePerson }));
    await user.click(screen.getByRole('radio', { name: 'Личный ИИ-ассистент' }));
    expect(screen.getByLabelText('Владелец')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Создать ассистента' })).toBeInTheDocument();
    localStorage.clear();
  });
});

describe('the forms to add and edit people', () => {
  const lists = { 'GET /api/people': [200, { people: PEOPLE }] as [number, unknown], 'GET /api/org': [200, ORG_WITH_TEAMS] as [number, unknown] };
  async function openInvite(user: ReturnType<typeof userEvent.setup>) {
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Invite person' }));
  }
  /* The buttons of a group, in the order a person meets them. */
  const groupOf = (button: HTMLElement) => {
    const foot = button.parentElement!;
    expect(foot).toHaveClass('form-foot');
    return within(foot).getAllByRole('button');
  };

  it('asks first whether a person or a personal AI assistant joins, each a card with its icon, a person by default', async () => {
    mockApi(lists);
    const user = userEvent.setup();
    await openInvite(user);
    expect(screen.getByRole('heading', { name: 'Add a member to the company' })).toBeInTheDocument();
    const [person, assistant] = within(screen.getByRole('radiogroup', { name: 'Person or assistant' })).getAllByRole('radio');
    expect(person).toHaveAccessibleName('Person');
    expect(person).toHaveAccessibleDescription('Signs in with a one-time invite link in the browser');
    expect(assistant).toHaveAccessibleName('Personal AI assistant');
    expect(assistant).toHaveAccessibleDescription('Connects your own program with a key');
    expect(person).toBeChecked();
    expect(assistant).not.toBeChecked();
    for (const card of [person!, assistant!]) expect(card.closest('label')!.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(iconOf(person!.closest('label')!)).toBe(drawn(<PersonIcon />));
    expect(iconOf(assistant!.closest('label')!)).toBe(drawn(<AgentIcon />));
    expect(person!.closest('label')).toHaveClass('kind-card', 'on');
    expect(assistant!.closest('label')).not.toHaveClass('on');
    expect(iconOf(screen.getByRole('heading', { name: 'Add a member to the company' }))).toBe(drawn(<PersonIcon />));
    expect(screen.queryByRole('checkbox', { name: /agent/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('turns into the assistant form and back under the same heading, keeping the name typed', async () => {
    mockApi(lists);
    const user = userEvent.setup();
    await openInvite(user);
    await user.type(screen.getByLabelText('Name'), 'Oleg');
    await user.click(screen.getByRole('radio', { name: 'Personal AI assistant' }));
    expect(screen.getByRole('radio', { name: 'Personal AI assistant' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Person' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Personal AI assistant' }).closest('label')).toHaveClass('on');
    expect(screen.getByRole('radio', { name: 'Person' }).closest('label')).not.toHaveClass('on');
    expect(iconOf(screen.getByRole('heading', { name: 'Add a member to the company' }))).toBe(drawn(<PersonIcon />));
    expect(screen.getByLabelText('Assistant name')).toHaveValue('Oleg');
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Program')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Person' }));
    expect(screen.getByRole('radio', { name: 'Person' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Personal AI assistant' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Person' }).closest('label')).toHaveClass('on');
    expect(screen.getByRole('radio', { name: 'Personal AI assistant' }).closest('label')).not.toHaveClass('on');
    expect(screen.getByLabelText('Name')).toHaveValue('Oleg');
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByLabelText('Program')).not.toBeInTheDocument();
  });

  it('keeps the focus on the choice of person or assistant, so the arrow keys go on moving between them', async () => {
    mockApi(lists);
    const user = userEvent.setup();
    await openInvite(user);
    await user.click(screen.getByRole('radio', { name: 'Personal AI assistant' }));
    expect(screen.getByRole('radio', { name: 'Personal AI assistant' })).toHaveFocus();
    await user.click(screen.getByRole('radio', { name: 'Person' }));
    expect(screen.getByRole('radio', { name: 'Person' })).toHaveFocus();
  });

  it('says Creating… on the main button while the invite goes, keeping its place before Cancel', async () => {
    let finish!: (reply: [number, unknown]) => void;
    mockApi({ ...lists, 'POST /api/people/invite': () => new Promise(resolve => { finish = resolve; }) });
    const user = userEvent.setup();
    await openInvite(user);
    await user.type(screen.getByLabelText('Name'), 'Oleg');
    await user.type(screen.getByLabelText('Email'), 'oleg@acme.com');
    const create = screen.getByRole('button', { name: 'Create invite link' });
    expect(groupOf(create)).toEqual([create, screen.getByRole('button', { name: 'Cancel' })]);
    expect(create).not.toHaveAttribute('aria-busy', 'true');
    await user.click(create);
    expect(create).toHaveAccessibleName('Creating…');
    expect(create).toHaveAttribute('aria-busy', 'true');
    expect(create).toBeDisabled();
    /* The idle words stay in the button, unseen, so it keeps its width. */
    expect(create.querySelector('[aria-hidden="true"]')).toHaveTextContent('Create invite link');
    await act(async () => { finish([201, { person: PEOPLE[2], inviteUrl: 'https://hq.acme.com/invite/T' }]); });
    expect(await screen.findByText('https://hq.acme.com/invite/T')).toBeInTheDocument();
  });

  it('shows the one-time link right under its note, with Copy and Done in one group under it', async () => {
    const link = 'https://hq.acme.com/invite/TOKEN123';
    mockApi({ ...lists, 'POST /api/people/invite': [201, { person: PEOPLE[2], inviteUrl: link }] });
    const user = userEvent.setup();
    await openInvite(user);
    await user.type(screen.getByLabelText('Name'), 'Sasha');
    await user.type(screen.getByLabelText('Email'), 'sasha@acme.com');
    await user.click(screen.getByRole('button', { name: 'Create invite link' }));
    expect(await screen.findByRole('heading', { name: 'Invite link for Sasha is ready' })).toBeInTheDocument();
    const note = screen.getByText('Send it to the person yourself. It works once, for 7 days, and is shown only now.');
    const code = screen.getByText(link);
    expect(code.tagName).toBe('CODE');
    expect(note.nextElementSibling).toBe(code);
    const copy = screen.getByRole('button', { name: 'Copy' });
    expect(code.nextElementSibling).toBe(copy.parentElement);
    expect(groupOf(copy)).toEqual([copy, screen.getByRole('button', { name: 'Done' })]);
  });

  it('edits in the same grid, with the deputy under Authority, Save before Cancel, and Saving… while it goes', async () => {
    let finish!: (reply: [number, unknown]) => void;
    mockApi({ ...lists, 'PATCH /api/people/p2': () => new Promise(resolve => { finish = resolve; }) });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Edit Maria' }));
    const heading = screen.getByRole('heading', { name: 'Edit Maria' });
    expect(heading.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    const deputy = screen.getByRole('switch', { name: 'Deputy CEO' });
    expect(deputy.closest('.field')!.querySelector(':scope > .label')).toHaveTextContent('Authority');
    expect(screen.getByRole('group', { name: 'Company access' })).toBeInTheDocument();
    expect(screen.getByLabelText('Telegram')).toHaveAccessibleDescription('@name or the account number, so the bots know the person.');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(groupOf(save)).toEqual([save, screen.getByRole('button', { name: 'Cancel' })]);
    await user.type(screen.getByLabelText('Title'), ' and COO');
    await user.click(save);
    expect(save).toHaveAccessibleName('Saving…');
    expect(save).toHaveAttribute('aria-busy', 'true');
    await act(async () => { finish([200, { person: { ...PEOPLE[1]!, title: 'Deputy CEO and COO' } }]); });
    expect(await within(rowOf('Maria')).findByText('Deputy CEO and COO')).toBeInTheDocument();
  });

  it('says Creating… on the assistant form too, and gives its fields the short names', async () => {
    let finish!: (reply: [number, unknown]) => void;
    mockApi({ ...lists, 'POST /api/people/assistants': () => new Promise(resolve => { finish = resolve; }) });
    const user = userEvent.setup();
    await openInvite(user);
    await user.click(screen.getByRole('radio', { name: 'Personal AI assistant' }));
    expect(screen.getByLabelText('Owner')).toHaveAccessibleDescription('Person on whose behalf this assistant operates.');
    expect(screen.getByLabelText('Events address')).toHaveAccessibleDescription('Optional. Here Hornhoof tells the program that something is new.');
    await user.type(screen.getByLabelText('Assistant name'), 'Ava');
    const create = screen.getByRole('button', { name: 'Create assistant' });
    expect(groupOf(create)).toEqual([create, screen.getByRole('button', { name: 'Cancel' })]);
    await user.click(create);
    expect(create).toHaveAccessibleName('Creating…');
    expect(create).toHaveAttribute('aria-busy', 'true');
    await act(async () => { finish([500, { error: { code: 'internal', message: 'x' } }]); });
    expect(create).toHaveAccessibleName('Create assistant');
    expect(create).toBeEnabled();
  });

  it('lays the forms out with classes alone, with no inline style', async () => {
    mockApi(lists);
    const user = userEvent.setup();
    const { container } = render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Invite person' }));
    expect(container.querySelector('form [style]')).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Personal AI assistant' }));
    expect(container.querySelector('form [style]')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Edit Maria' }));
    expect(container.querySelector('form [style]')).toBeNull();
  });

  it('puts each label in a 180 px column beside its field, with 12 px between them and between rows, and above it in a narrow place', () => {
    const narrow = 'form (max-width: 479px)';
    expect(decl('.form-grid', 'container')).toBe('form / inline-size');
    expect(decl('.form-grid', 'gap')).toBe('12px');
    expect(decl('.form-grid .field', 'grid-template-columns')).toBe('180px minmax(0, 1fr)');
    expect(decl('.form-grid .field', 'gap')).toBe('12px');
    expect(decl('.form-grid .field > :is(label, .label)', 'padding-block-start')).toBe('10px');
    expect(decl('.form-grid .field-control', 'gap')).toBe('4px');
    expect(decl('.form-grid .field', 'grid-template-columns', narrow)).toBe('minmax(0, 1fr)');
    expect(decl('.form-grid .field', 'gap', narrow)).toBe('6px');
    expect(decl('.form-grid .field > :is(label, .label)', 'padding-block-start', narrow)).toBe('0');
    expect(decl('.kind-switch', 'grid-template-columns')).toBe('repeat(2, minmax(0, 1fr))');
    expect(decl('.kind-switch', 'grid-template-columns', narrow)).toBe('minmax(0, 1fr)');
    expect(decl('.kind-card', 'min-height')).toBe('44px');
    expect(decl('.kind-card > .ic', 'width')).toBe('20px');
    expect(decl('.busy-swap > [aria-hidden="true"]', 'visibility')).toBe('hidden');
  });

  it('names the choice and the new buttons in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    mockApi(lists);
    const user = userEvent.setup();
    render(<LanguageProvider><People me={ME} /></LanguageProvider>);
    await user.click(await screen.findByRole('button', { name: ru.people.invitePerson }));
    expect(screen.getByRole('heading', { name: 'Добавить участника в компанию' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Человек' })).toHaveAccessibleDescription('Вход по одноразовой ссылке и работа в браузере');
    expect(screen.getByRole('radio', { name: 'Личный ИИ-ассистент' })).toHaveAccessibleDescription('Подключение своей программы по ключу');
    expect(screen.getByRole('button', { name: 'Создать ссылку' })).toBeInTheDocument();
    localStorage.clear();
  });
});
