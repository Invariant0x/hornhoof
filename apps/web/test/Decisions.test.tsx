import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { People } from '../src/screens/People';
import type { ComputerView, Me, PersonView, StructureItem, WaitingRequest } from '../src/types';
import { ComputerCard } from '../src/ui/ComputerCard';
import { Requests } from '../src/ui/Requests';
import { StaffCard } from '../src/ui/StaffCard';
import { StructureCard } from '../src/ui/StructureCard';
import { ME, mockApi, ORG_WITH_TEAMS, PEOPLE, REQUESTS, ROSTER } from './api-mock';

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

  it('shows the cards and the computer without their buttons', async () => {
    mockApi({ 'GET /api/departments/d2/roster': [200, ROSTER] });
    const items: StructureItem[] = [{ template: 'design', checked: true, note: 'Screens' }];
    const asked: ComputerView = { available: true, until: null, asked: { reason: 'Clean Docker images.', at: '2026-11-03T04:00:00.000Z' }, machine: null, canAnswer: false };
    render(
      <>
        <StructureCard proposal={{ id: 'pr1', brief: '', items }} departments={[]} onCorrect={noop} locked={ceo} />
        <StaffCard department={DEV} proposal={{ id: 'pr2', brief: 'QA first.', people: [{ role: ROSTER.roles[0]!.id, checked: true }] }} onCorrect={noop} locked={ceo} />
        <ComputerCard view={asked} onChange={noop} onFailure={noop} />
      </>,
    );
    expect(await screen.findAllByText('Decided by the CEO or the CEO delegate.')).toHaveLength(3);
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
    for (const name of [/Create departments/, /Hire/, 'Correct in words', 'Open access for a day', 'Not now']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.getByText('Clean Docker images.')).toBeInTheDocument();
  });
});

describe('the CEO delegate on People', () => {
  const people: PersonView[] = [PEOPLE[0]!, { ...PEOPLE[1]!, isCeoDelegate: false }, { ...PEOPLE[1]!, id: 'p4', name: 'Dave', email: 'dave@acme.com', isCeoDelegate: true }, PEOPLE[2]!];

  it('lets the CEO set and take off the mark of a person who sees the whole company', async () => {
    const calls = mockApi({
      'GET /api/people': [200, { people }],
      'GET /api/org': [200, ORG_WITH_TEAMS],
      'PUT /api/people/p2/ceo-delegate': [200, { person: { ...people[1]!, isCeoDelegate: true } }],
    });
    const user = userEvent.setup();
    render(<People me={ME} />);
    const maria = await screen.findByRole('checkbox', { name: 'Maria is the CEO delegate' });
    expect(maria).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Dave is the CEO delegate' })).toBeChecked();
    /* Not for the CEO, nor for someone invited to a team. */
    expect(screen.getAllByRole('checkbox', { name: /is the CEO delegate$/ })).toHaveLength(2);
    await user.click(maria);
    expect(calls.find(c => c.method === 'PUT')).toEqual({ method: 'PUT', path: '/api/people/p2/ceo-delegate', body: { isCeoDelegate: true } });
    expect(await screen.findByRole('checkbox', { name: 'Maria is the CEO delegate' })).toBeChecked();
  });

  it('shows anyone else who the delegate is, and leaves the delegate to the CEO', async () => {
    mockApi({ 'GET /api/people': [200, { people }], 'GET /api/org': [200, ORG_WITH_TEAMS] });
    render(<People me={ZED} />);
    const dave = await screen.findByRole('row', { name: /^Dave\b/ });
    expect(within(dave).getByText('CEO delegate')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(dave).queryByRole('button', { name: 'Disable Dave' })).not.toBeInTheDocument();
    expect(within(dave).queryByRole('button', { name: 'New invite link for Dave' })).not.toBeInTheDocument();
    const maria = screen.getByRole('row', { name: /^Maria\b/ });
    expect(within(maria).getByRole('button', { name: 'Disable Maria' })).toBeInTheDocument();
  });

  it('names the mark in Russian', async () => {
    mockApi({ 'GET /api/people': [200, { people }], 'GET /api/org': [200, ORG_WITH_TEAMS] });
    inRussian(<People me={ME} />);
    expect(await screen.findByRole('checkbox', { name: 'Заместитель CEO: Maria' })).toBeInTheDocument();
    expect(screen.getAllByText('Заместитель CEO').length).toBeGreaterThan(0);
  });
});

