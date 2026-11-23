import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { People } from '../src/screens/People';
import type { AccessInput, AccessView, Me, PersonView, StructureItem, WaitingRequest } from '../src/types';
import { Requests } from '../src/ui/Requests';
import { StaffCard } from '../src/ui/StaffCard';
import { StructureCard } from '../src/ui/StructureCard';
import { ME, mockApi, ORG_WITH_TEAMS, PEOPLE, REQUESTS, ROSTER, WHOLE } from './api-mock';

const noop = () => {};
const DEV = { id: 'd2', name: 'Development' };
const department = { kind: 'department_and_ceo' as const, department: DEV };
const ceo = { kind: 'ceo_and_delegate' as const, department: null };

/* Zed sees the whole company and is no CEO delegate. */
const ZED: Me = { ...ME, person: { ...ME.person, id: 'p9', name: 'Zed', title: '', isOwner: false, isCeoDelegate: false }, canDecideCompany: false };

function inRussian(node: ReactNode) {
  localStorage.setItem('hh-lang', 'ru');
  try {
    return render(<LanguageProvider>{node}</LanguageProvider>);
  } finally {
    localStorage.removeItem('hh-lang');
  }
}

const shared = { onChanged: noop, onOpenTask: noop, onOpenAgent: noop, placeName: () => 'Development' };
const question: WaitingRequest = { ...REQUESTS[0]!, canAnswer: false, decidedBy: department };
const approval: WaitingRequest = { ...REQUESTS[1]!, canAnswer: false, decidedBy: ceo };
const choice: WaitingRequest = { ...REQUESTS[0]!, id: 'r3', kind: 'choice', text: 'Which price?', options: [{ label: '9', image: null }, { label: '12', image: null }], canAnswer: false, decidedBy: ceo };

describe('a decision for someone who may not take it', () => {
  afterEach(() => localStorage.removeItem('hh-lang'));

  it('shows what is asked and who takes it, with no way to answer', () => {
    render(<Requests requests={[question, approval, choice]} {...shared} />);
    const [q, a, c] = screen.getAllByRole('article');
    expect(within(q!).getByText('Stripe or Adyen?')).toBeInTheDocument();
    expect(within(q!).getByText('Decided by the people of Development, the CEO or the CEO delegate.')).toBeInTheDocument();
    expect(within(a!).getByText('a'.repeat(40))).toBeInTheDocument();
    expect(within(a!).getByText('Decided by the CEO or the CEO delegate.')).toBeInTheDocument();
    expect(within(c!).getAllByRole('listitem').map(li => li.textContent)).toEqual(['9', '12']);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    for (const name of ['Send answer', 'Approve', 'Decline', '9', '12']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });

  it('keeps the buttons for someone who takes it', () => {
    render(<Requests requests={[{ ...question, canAnswer: true }, { ...approval, canAnswer: true }]} {...shared} />);
    expect(screen.getByRole('button', { name: 'Send answer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByText(/^Decided by/)).not.toBeInTheDocument();
  });

  it('says who takes it in Russian', () => {
    inRussian(<Requests requests={[question, approval]} {...shared} />);
    expect(screen.getByText('Принимают люди отдела Development, CEO или его заместитель.')).toBeInTheDocument();
    expect(screen.getByText('Принимает CEO или его заместитель.')).toBeInTheDocument();
  });

  it('shows the proposal cards without their buttons', async () => {
    mockApi({ 'GET /api/departments/d2/roster': [200, ROSTER] });
    const items: StructureItem[] = [{ template: 'design', checked: true, note: 'Screens' }];
    render(
      <>
        <StructureCard proposal={{ id: 'pr1', brief: '', items }} departments={[]} onCorrect={noop} locked={ceo} />
        <StaffCard department={DEV} proposal={{ id: 'pr2', brief: 'QA first.', people: [{ role: ROSTER.roles[0]!.id, checked: true }] }} onCorrect={noop} locked={ceo} />
      </>,
    );
    expect(await screen.findAllByText('Decided by the CEO or the CEO delegate.')).toHaveLength(2);
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
    for (const name of [/Create departments/, /Hire/, 'Correct in words', /^Open access to/, 'Not now']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });
});

describe('the deputy CEO on People', () => {
  const people: PersonView[] = [PEOPLE[0]!, { ...PEOPLE[1]!, isCeoDelegate: false }, { ...PEOPLE[1]!, id: 'p4', name: 'Dave', email: 'dave@acme.com', title: 'Designer', isCeoDelegate: true }, PEOPLE[2]!];
  /* Lena is active and works in Development alone. */
  const lena: PersonView = { ...PEOPLE[1]!, id: 'p5', name: 'Lena', email: 'lena@acme.com', title: 'Analyst', isCeoDelegate: false, access: { whole: false, departments: [{ id: 'd2', name: 'Development' }], teams: [] } };
  const about = "Takes the CEO's decisions and sees the whole company. Only you change their access, status and sign-in.";
  const routes = (list: PersonView[] = people): Parameters<typeof mockApi>[0] => ({ 'GET /api/people': [200, { people: list }], 'GET /api/org': [200, ORG_WITH_TEAMS] });
  /* What the server answers when asked for a deputy without the whole company. */
  const refused = { error: { code: 'conflict', message: 'Only an active person with access to the whole company can be the CEO delegate.' } };

  /* A server that keeps one person the way the server keeps the deputy for what Edit sends (apps/server/src/modules/people/
     routes.ts): only an active person with the whole company is made the deputy, a narrower access takes the deputy off,
     and a title alone leaves both. It leaves out what Edit never sends, a status, and the owner, whom Edit never offers.
     The list it gives holds the person as kept; person() is what it holds now. */
  function serverKeeping(start: PersonView, list: PersonView[]) {
    let person = start;
    const depts = ORG_WITH_TEAMS.departments;
    const reach = (a: AccessInput): AccessView =>
      'whole' in a
        ? WHOLE
        : {
            whole: false,
            departments: depts.filter(d => a.departments.includes(d.id)).map(d => ({ id: d.id, name: d.name ?? '' })),
            teams: depts.flatMap(d => d.teams.filter(x => a.teams.includes(x.id)).map(x => ({ id: x.id, name: x.name, departmentId: d.id }))),
          };
    const save = (body: unknown): [number, unknown] => {
      const { title, access } = body as { title: string; access?: AccessInput };
      person = access ? { ...person, title, access: reach(access), isCeoDelegate: Boolean(person.isCeoDelegate) && 'whole' in access } : { ...person, title };
      return [200, { person }];
    };
    const mark = (body: unknown): [number, unknown] => {
      const { isCeoDelegate } = body as { isCeoDelegate: boolean };
      if (isCeoDelegate && !(person.status === 'active' && person.access.whole)) return [409, refused];
      person = { ...person, isCeoDelegate };
      return [200, { person }];
    };
    const listed = (): [number, unknown] => [200, { people: list.map(p => (p.id === person.id ? person : p)) }];
    return { routes: { ...routes(list), 'GET /api/people': listed, [`PATCH /api/people/${start.id}`]: save, [`PUT /api/people/${start.id}/ceo-delegate`]: mark }, person: () => person };
  }

  it("keeps the row to Edit, New link, Disable and the CEO's Delete, with no tick for the deputy", async () => {
    mockApi(routes());
    render(<People me={ME} />);
    const maria = await screen.findByRole('row', { name: /^Maria\b/ });
    expect(within(maria).getAllByRole('button').map(b => b.textContent)).toEqual(['Edit', 'New link', 'Disable', 'Delete']);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('lets the CEO make someone the deputy in Edit, next to the access, and saves it as before', async () => {
    const calls = mockApi({
      ...routes(),
      'PATCH /api/people/p2': [200, { person: people[1]! }],
      'PUT /api/people/p2/ceo-delegate': [200, { person: { ...people[1]!, isCeoDelegate: true } }],
    });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Edit Maria' }));
    const deputy = screen.getByRole('switch', { name: 'Deputy CEO' });
    expect(deputy).not.toBeChecked();
    expect(deputy).toHaveAccessibleDescription(about);
    /* In the same form as the access, in the row right after it. */
    const access = screen.getByRole('group', { name: 'Company access' });
    expect(access.nextElementSibling).toBe(deputy.closest('.field'));
    await user.click(deputy);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Make deputy' }));
    expect(calls.filter(c => c.method !== 'GET')).toEqual([
      { method: 'PATCH', path: '/api/people/p2', body: { title: 'Deputy CEO', access: { whole: true } } },
      { method: 'PUT', path: '/api/people/p2/ceo-delegate', body: { isCeoDelegate: true } },
    ]);
    const maria = await screen.findByRole('row', { name: /^Maria\b/ });
    expect(within(maria).getByRole('img', { name: 'Deputy CEO' })).toHaveTextContent('Dep');
  });

  it('takes the deputy off in Edit', async () => {
    const calls = mockApi({
      ...routes(),
      'PATCH /api/people/p4': [200, { person: people[2]! }],
      'PUT /api/people/p4/ceo-delegate': [200, { person: { ...people[2]!, isCeoDelegate: false } }],
    });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Edit Dave' }));
    const deputy = screen.getByRole('switch', { name: 'Deputy CEO' });
    expect(deputy).toBeChecked();
    await user.click(deputy);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Take away' }));
    expect(calls.filter(c => c.method === 'PUT')).toEqual([{ method: 'PUT', path: '/api/people/p4/ceo-delegate', body: { isCeoDelegate: false } }]);
    const dave = await screen.findByRole('row', { name: /^Dave\b/ });
    expect(within(dave).queryByRole('img', { name: 'Deputy CEO' })).not.toBeInTheDocument();
  });

  it('saves the title and the access alone when the deputy stays as it was', async () => {
    const calls = mockApi({ ...routes(), 'PATCH /api/people/p4': [200, { person: people[2]! }] });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Edit Dave' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument());
    expect(calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`)).toEqual(['PATCH /api/people/p4']);
  });

  /* The deputy may change in another window while this one is open: a save that did not touch the switch leaves it. */
  it('keeps a deputy made elsewhere when only the title is saved', async () => {
    const calls = mockApi({ ...routes(), 'PATCH /api/people/p2': [200, { person: { ...people[1]!, isCeoDelegate: true } }] });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Edit Maria' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const maria = await screen.findByRole('row', { name: /^Maria\b/ });
    expect(within(maria).getByRole('img', { name: 'Deputy CEO' })).toBeInTheDocument();
    expect(calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`)).toEqual(['PATCH /api/people/p2']);
  });

  it('sends no deputy call from a window without the switch, whatever the deputy became meanwhile', async () => {
    const calls = mockApi({ ...routes(), 'PATCH /api/people/p4': [200, { person: { ...people[2]!, isCeoDelegate: false } }] });
    const user = userEvent.setup();
    render(<People me={ZED} />);
    await user.click(await screen.findByRole('button', { name: 'Edit Dave' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument());
    expect(calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`)).toEqual(['PATCH /api/people/p4']);
  });

  it('shows the saved title and access in the row when the deputy call fails after them', async () => {
    const saved = { ...lena, access: { whole: true, departments: [], teams: [] } };
    mockApi({
      ...routes([...people, lena]),
      'PATCH /api/people/p5': [200, { person: saved }],
      'PUT /api/people/p5/ceo-delegate': [409, refused],
    });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Edit Lena' }));
    await user.click(screen.getByRole('switch', { name: 'Deputy CEO' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Deputy CEO' })).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /^Lena\b/ })).getByText('Whole company')).toBeInTheDocument();
  });

  it('gives back the access a person had when the deputy is switched off again in the same window', async () => {
    const calls = mockApi({ ...routes([...people, lena]), 'PATCH /api/people/p5': [200, { person: lena }] });
    const user = userEvent.setup();
    render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Edit Lena' }));
    const deputy = screen.getByRole('switch', { name: 'Deputy CEO' });
    await user.click(deputy);
    await user.click(deputy);
    expect(screen.getByRole('checkbox', { name: 'Whole company' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Development' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument());
    expect(calls.filter(c => c.method !== 'GET')).toEqual([{ method: 'PATCH', path: '/api/people/p5', body: { title: 'Analyst', access: { departments: ['d2'], teams: [] } } }]);
  });

  it('tells the CEO under the table where the deputy is made', async () => {
    mockApi(routes());
    render(<People me={ME} />);
    expect(await screen.findByText('Deputy CEO: Only you make someone the deputy or take it off, in Edit.')).toBeInTheDocument();
  });

  it('offers the deputy to the CEO alone, for someone active or the deputy already, and not in the CEO\'s own window', async () => {
    const off: PersonView = { ...people[2]!, status: 'disabled' };
    mockApi(routes([people[0]!, people[1]!, off, people[3]!]));
    const user = userEvent.setup();
    const { unmount } = render(<People me={ME} />);
    await user.click(await screen.findByRole('button', { name: 'Edit Sasha' }));
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit Ivan' }));
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    /* A deputy switched off can still be taken off. */
    await user.click(screen.getByRole('button', { name: 'Edit Dave' }));
    expect(screen.getByRole('switch', { name: 'Deputy CEO' })).toBeChecked();
    unmount();
    render(<People me={ZED} />);
    await user.click(await screen.findByRole('button', { name: 'Edit Maria' }));
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it("shows anyone else the deputy's short mark with the whole name on hover, and leaves the deputy to the CEO", async () => {
    mockApi(routes());
    render(<People me={ZED} />);
    const dave = await screen.findByRole('row', { name: /^Dave\b/ });
    const mark = within(dave).getByRole('img', { name: 'Deputy CEO' });
    expect(mark).toHaveAttribute('title', 'Deputy CEO');
    expect(mark).toHaveTextContent(/^Dep$/);
    expect(within(screen.getByRole('row', { name: /^Maria\b/ })).queryByRole('img', { name: 'Deputy CEO' })).not.toBeInTheDocument();
    expect(within(dave).queryByRole('button', { name: 'Disable Dave' })).not.toBeInTheDocument();
    expect(within(dave).queryByRole('button', { name: 'New invite link for Dave' })).not.toBeInTheDocument();
    const maria = screen.getByRole('row', { name: /^Maria\b/ });
    expect(within(maria).getByRole('button', { name: 'Disable Maria' })).toBeInTheDocument();
  });

  it('names the deputy in Russian', async () => {
    mockApi(routes());
    const user = userEvent.setup();
    inRussian(<People me={ME} />);
    const dave = await screen.findByRole('row', { name: /^Dave\b/ });
    const mark = within(dave).getByRole('img', { name: 'Заместитель CEO' });
    expect(mark).toHaveAttribute('title', 'Заместитель CEO');
    expect(mark).toHaveTextContent(/^Зам$/);
    await user.click(screen.getByRole('button', { name: 'Изменить Maria' }));
    expect(screen.getByRole('switch', { name: 'Заместитель CEO' })).toHaveAccessibleDescription('Принимает решения за CEO и видит всю компанию. Его доступ, статус и вход меняете только вы.');
  });

  /* Switching the deputy on gives the whole company and hides the departments, and
     taking the whole company off switches the deputy off. Save sends only what the server keeps: a deputy with the whole
     company. */
  describe.each([
    { language: 'English', show: render, deputy: 'Deputy CEO', whole: 'Whole company', edit: 'Edit', save: 'Save' },
    { language: 'Russian', show: inRussian, deputy: 'Заместитель CEO', whole: 'Вся компания', edit: 'Изменить', save: 'Сохранить' },
  ])('in $language', ({ show, deputy, whole, edit, save }) => {
    it('switching the deputy on gives the whole company and hides the departments, and the server makes the person the deputy', async () => {
      const server = serverKeeping(lena, [...people, lena]);
      const calls = mockApi(server.routes);
      const user = userEvent.setup();
      show(<People me={ME} />);
      await user.click(await screen.findByRole('button', { name: `${edit} Lena` }));
      expect(screen.getByRole('checkbox', { name: 'Development' })).toBeChecked();
      await user.click(screen.getByRole('switch', { name: deputy }));
      expect(screen.getByRole('checkbox', { name: whole })).toBeChecked();
      expect(screen.queryByRole('checkbox', { name: 'Development' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: save }));
      await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: save }));
      await vi.waitFor(() => expect(screen.queryByRole('button', { name: save })).not.toBeInTheDocument());
      expect(calls.filter(c => c.method !== 'GET')).toEqual([
        { method: 'PATCH', path: '/api/people/p5', body: { title: 'Analyst', access: { whole: true } } },
        { method: 'PUT', path: '/api/people/p5/ceo-delegate', body: { isCeoDelegate: true } },
      ]);
      expect(server.person()).toMatchObject({ isCeoDelegate: true, access: { whole: true } });
      const row = screen.getByRole('row', { name: /^Lena\b/ });
      expect(within(row).getByRole('img', { name: deputy })).toBeInTheDocument();
      expect(within(row).getByText(whole)).toBeInTheDocument();
    });

    it('taking the whole company off switches the deputy off, and the server keeps the narrower access without the deputy', async () => {
      const server = serverKeeping(people[2]!, people);
      const calls = mockApi(server.routes);
      const user = userEvent.setup();
      show(<People me={ME} />);
      await user.click(await screen.findByRole('button', { name: `${edit} Dave` }));
      expect(screen.getByRole('switch', { name: deputy })).toBeChecked();
      await user.click(screen.getByRole('checkbox', { name: whole }));
      expect(screen.getByRole('switch', { name: deputy })).not.toBeChecked();
      await user.click(screen.getByRole('checkbox', { name: 'Development' }));
      await user.click(screen.getByRole('button', { name: save }));
      const confirm = screen.getByRole('alertdialog');
      expect(within(confirm).getByRole('button', { name: save })).toHaveClass('danger');
      await user.click(within(confirm).getByRole('button', { name: save }));
      await vi.waitFor(() => expect(screen.queryByRole('button', { name: save })).not.toBeInTheDocument());
      expect(calls.filter(c => c.method !== 'GET')).toEqual([{ method: 'PATCH', path: '/api/people/p4', body: { title: 'Designer', access: { departments: ['d2'], teams: [] } } }]);
      expect(server.person()).toMatchObject({ isCeoDelegate: false, access: { whole: false } });
      const row = screen.getByRole('row', { name: /^Dave\b/ });
      expect(within(row).queryByRole('img', { name: deputy })).not.toBeInTheDocument();
      expect(within(row).getByText('Development')).toBeInTheDocument();
    });

    it('taking the whole company off right after switching the deputy on switches the deputy off again', async () => {
      mockApi(routes([...people, lena]));
      const user = userEvent.setup();
      show(<People me={ME} />);
      await user.click(await screen.findByRole('button', { name: `${edit} Lena` }));
      await user.click(screen.getByRole('switch', { name: deputy }));
      await user.click(screen.getByRole('checkbox', { name: whole }));
      expect(screen.getByRole('switch', { name: deputy })).not.toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'Development' })).toBeInTheDocument();
    });
  });
});
