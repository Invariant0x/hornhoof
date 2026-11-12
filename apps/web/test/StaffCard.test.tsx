import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import type { Roster, StaffLine } from '../src/types';
import { StaffCard } from '../src/ui/StaffCard';
import { mockApi, ROSTER } from './api-mock';
import { decl } from './css';

const DEPT = { id: 'd2', name: 'Development' };

function card(proposal?: { id: string; brief: string; people: StaffLine[] }, roster = ROSTER) {
  const calls = mockApi({ 'GET /api/departments/d2/roster': [200, roster], 'POST /api/departments/d2/staff': [201, { hired: ['x1', 'x2'] }] });
  render(
    <LanguageProvider>
      <StaffCard department={DEPT} proposal={proposal} onCorrect={() => {}} />
    </LanguageProvider>,
  );
  return calls;
}

const OPS = { id: 'd1', name: 'Operations' };
const member = (id: string, en: string, ru: string, required: boolean, holder: string | null) => ({ id, title: { en, ru }, kind: 'member' as const, tier: 'standard' as const, perProduct: false, skills: ['hh-report-to-head'], subscription: 's-key', required, holder });
/* Operations with its head and watchdog there, and its operator missing, as the server sends it. */
const OPS_ROSTER: Roster = {
  ...ROSTER,
  people: [
    { role: 'OPS-HEAD', name: 'Head of operations', product: null, model: '', subscription: 's-key', skills: [] },
    { role: 'OPS-WATCH', name: 'Task watchdog', product: null, model: '', subscription: 's-key', skills: [] },
    { role: 'OPS-PROGRAM', name: 'Program operator', product: null, model: '', subscription: 's-key', skills: [] },
    { role: 'OPS-FIX', name: 'Reliability engineer', product: null, model: '', subscription: 's-key', skills: [] },
  ],
  roles: [
    { ...member('OPS-HEAD', 'Head of operations', 'Руководитель операционного отдела', true, 'Hanna'), kind: 'head' },
    member('OPS-WATCH', 'Task watchdog', 'Сторож задач', true, 'Argus'),
    member('OPS-PROGRAM', 'Program operator', 'Оператор программ', true, null),
    member('OPS-FIX', 'Reliability engineer', 'Инженер надежности', false, null),
  ],
  products: [],
};
const WHOLE_STAFF: Roster = { ...OPS_ROSTER, roles: OPS_ROSTER.roles.map(r => (r.id === 'OPS-PROGRAM' ? { ...r, holder: 'Otto' } : r)) };

function opsCard(proposal?: { id: string; brief: string; people: StaffLine[] }, roster = OPS_ROSTER) {
  const calls = mockApi({ 'GET /api/departments/d1/roster': [200, roster], 'POST /api/departments/d1/staff': [201, { hired: [], present: [] }] });
  render(
    <LanguageProvider>
      <StaffCard department={OPS} proposal={proposal} onCorrect={() => {}} />
    </LanguageProvider>,
  );
  return calls;
}

const options = (select: HTMLElement) => within(select).getAllByRole('option').map(o => o.textContent);

describe('StaffCard', () => {
  it('hires the ticked people with the picked models', async () => {
    const user = userEvent.setup();
    const calls = card({
      id: 'pr9',
      brief: 'Start with the API.',
      people: [
        { role: 'DEV-HEAD', checked: true },
        { role: 'DEV-BE', name: 'Bruno', checked: true, skills: { on: ['dev-api-design'], off: ['dev-tdd'] } },
        { role: 'DEV-FE', product: 'pd1', checked: false },
      ],
    });
    expect(await screen.findByText('Start with the API.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /^Frontend \(Mascot\)/ })).not.toBeChecked();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model for Bruno' }), 'claude-sonnet-5-5');
    await user.click(screen.getByRole('button', { name: 'Hire (2)' }));
    await vi.waitFor(() =>
      expect(calls.find(c => c.method === 'POST')?.body).toEqual({
        proposalId: 'pr9',
        people: [
          { role: 'DEV-HEAD', name: 'Head of development', product: null, model: '', subscription: 's-key', skills: ['hh-report-to-head', 'hh-break-down'] },
          { role: 'DEV-BE', name: 'Bruno', product: null, model: 'claude-sonnet-5-5', subscription: 's-key', skills: ['hh-report-to-head', 'dev-api-design'] },
        ],
      }),
    );
    expect(await screen.findByText('Hired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hire (2)' })).toBeDisabled();
  });

  it('changes the model list when another subscription is picked', async () => {
    const user = userEvent.setup();
    card();
    const model = await screen.findByRole('combobox', { name: 'Model for Backend engineer' });
    expect(options(model)).toEqual(['Default', 'Claude Opus 5.5', 'Claude Sonnet 5.5']);
    await user.selectOptions(model, 'claude-opus-5-5');
    const runs = screen.getByRole('combobox', { name: 'Subscription for Backend engineer' });
    expect(options(runs)).toEqual(['None yet', 'Codex, Oleg', 'Team key (Anthropic)']);
    expect(within(runs).getAllByRole('group').map(g => g.getAttribute('label'))).toEqual(['Codex', 'Anthropic']);
    await user.selectOptions(runs, 's-codex');
    expect(options(model)).toEqual(['Default', 'GPT-6.1 Sol']);
    expect(model).toHaveValue('');
  });

  it('says where to add a subscription when none serves the department', async () => {
    card(undefined, { ...ROSTER, subscriptions: [], roles: ROSTER.roles.map(r => ({ ...r, subscription: null })) });
    expect(await screen.findByText('No subscription serves this department yet. Connect one in Subscriptions; those hired now will wait.')).toBeInTheDocument();
  });

  it("names the people in the person's language", async () => {
    localStorage.setItem('hh-lang', 'ru');
    try {
      card({
        id: 'pr10',
        brief: 'API and UI.',
        people: [
          { role: 'DEV-HEAD', checked: true },
          { role: 'DEV-BE', checked: true },
          { role: 'DEV-FE', product: 'pd1', checked: false },
        ],
      });
      expect(await screen.findByRole('checkbox', { name: /Бэкенд-разработчик/ })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: /^Фронтенд \(Mascot\)/ })).not.toBeChecked();
      expect(screen.getByRole('button', { name: 'Нанять (2)' })).toBeInTheDocument();
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });

  describe('in Operations', () => {
    it('keeps a required role ticked, even when the proposal unticked it, and hires it', async () => {
      const user = userEvent.setup();
      const calls = opsCard({ id: 'pr1', brief: 'Staff it.', people: [{ role: 'OPS-PROGRAM', checked: false }, { role: 'OPS-FIX', checked: true }] });
      const box = await screen.findByRole('checkbox', { name: /Program operator/ });
      expect(box).toBeChecked();
      expect(box).toBeDisabled();
      await user.click(box);
      expect(box).toBeChecked();
      expect(within(box.closest('label')!).getByText('Required role')).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'Subscription for Program operator' })).toBeEnabled();
      await user.click(screen.getByRole('button', { name: 'Hire (2)' }));
      await vi.waitFor(() => expect((calls.find(c => c.method === 'POST')?.body as { people: { role: string }[] }).people.map(p => p.role)).toContain('OPS-PROGRAM'));
    });

    it('lets another role be unticked, and does not call it required', async () => {
      const user = userEvent.setup();
      opsCard({ id: 'pr1', brief: 'Staff it.', people: [{ role: 'OPS-PROGRAM', checked: true }, { role: 'OPS-FIX', checked: true }] });
      const box = await screen.findByRole('checkbox', { name: /Reliability engineer/ });
      expect(box).toBeEnabled();
      expect(within(box.closest('label')!).queryByText('Required role')).not.toBeInTheDocument();
      await user.click(box);
      expect(box).not.toBeChecked();
      expect(screen.getByRole('combobox', { name: 'Subscription for Reliability engineer' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Hire (1)' })).toBeEnabled();
    });

    it('adds the required roles an older proposal left out', async () => {
      opsCard({ id: 'pr1', brief: 'Staff it.', people: [{ role: 'OPS-FIX', checked: true }] });
      for (const name of [/Head of operations/, /Task watchdog/, /Program operator/]) {
        const box = await screen.findByRole('checkbox', { name });
        expect(box).toBeChecked();
        expect(box).toBeDisabled();
      }
    });

    it('shows who holds a role, with nothing to pick for them', async () => {
      opsCard();
      const box = await screen.findByRole('checkbox', { name: /Task watchdog/ });
      expect(box).toBeChecked();
      expect(box).toBeDisabled();
      expect(within(box.closest('label')!).getByText('Already here: Argus')).toBeInTheDocument();
      expect(screen.queryByRole('combobox', { name: 'Where Task watchdog runs' })).not.toBeInTheDocument();
      expect(screen.queryByRole('combobox', { name: 'Model for Task watchdog' })).not.toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'Subscription for Program operator' })).toBeInTheDocument();
    });

    it('by hand hires only who is not there', async () => {
      const user = userEvent.setup();
      const calls = opsCard();
      await user.click(await screen.findByRole('button', { name: 'Hire (2)' }));
      await vi.waitFor(() => expect((calls.find(c => c.method === 'POST')?.body as { people: { role: string }[] }).people.map(p => p.role)).toEqual(['OPS-PROGRAM', 'OPS-FIX']));
    });

    it('by hand offers no hire when everyone is there and the rest is unticked', async () => {
      const user = userEvent.setup();
      opsCard(undefined, WHOLE_STAFF);
      await user.click(await screen.findByRole('checkbox', { name: /Reliability engineer/ }));
      expect(screen.getByRole('button', { name: 'Hire (0)' })).toBeDisabled();
    });

    it('counts only who a proposal really hires, and leaves the server to skip the rest', async () => {
      const user = userEvent.setup();
      const calls = opsCard({ id: 'pr1', brief: 'Staff it.', people: [{ role: 'OPS-WATCH', checked: true }, { role: 'OPS-FIX', checked: true }] });
      await user.click(await screen.findByRole('button', { name: 'Hire (2)' }));
      await vi.waitFor(() => expect((calls.find(c => c.method === 'POST')?.body as { proposalId: string; people: { role: string }[] }).people.map(p => p.role).sort()).toEqual(['OPS-FIX', 'OPS-HEAD', 'OPS-PROGRAM', 'OPS-WATCH']));
      expect(await screen.findByText('Hired')).toBeInTheDocument();
    });

    it('closes a proposal with nobody left to hire, and does not say anyone was hired', async () => {
      const user = userEvent.setup();
      const calls = opsCard({ id: 'pr1', brief: 'Old.', people: [{ role: 'OPS-WATCH', checked: true }, { role: 'OPS-FIX', checked: false }] }, WHOLE_STAFF);
      await user.click(await screen.findByRole('button', { name: 'Nothing to hire, close' }));
      await vi.waitFor(() => expect((calls.find(c => c.method === 'POST')?.body as { proposalId: string }).proposalId).toBe('pr1'));
      expect(await screen.findByText('Applied')).toBeInTheDocument();
      expect(screen.queryByText('Hired')).not.toBeInTheDocument();
    });

    it('marks nothing in another department', async () => {
      card();
      const box = await screen.findByRole('checkbox', { name: /Backend engineer/ });
      expect(box).toBeEnabled();
      expect(screen.queryByText('Required role')).not.toBeInTheDocument();
    });

    it('says it in Russian too', async () => {
      localStorage.setItem('hh-lang', 'ru');
      try {
        opsCard();
        const box = await screen.findByRole('checkbox', { name: /Сторож задач/ });
        expect(within(box.closest('label')!).getByText('Обязательная роль')).toBeInTheDocument();
        expect(within(box.closest('label')!).getByText('Уже в отделе: Argus')).toBeInTheDocument();
      } finally {
        localStorage.removeItem('hh-lang');
      }
    });
  });

  it('opens a sealed native staffing proposal document in MaterialViewer without calling hire or altering the original snapshot on card edits', async () => {
    const user = userEvent.setup();
    const proposalDocId = '11111111-1111-4111-8111-111111111111';
    const contentUrl = `/api/proposals/pr9/materials/${proposalDocId}/content`;
    const sealedText = 'Proposed Development staffing:\n- Head of development\n- Bruno (Backend engineer)\n- Frontend (Mascot)';
    const calls: { method: string; path: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      if (method === 'GET' && path === '/api/departments/d2/roster') {
        return new Response(JSON.stringify(ROSTER), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (method === 'GET' && path === '/api/proposals/pr9/materials') {
        return new Response(JSON.stringify({
          materialRevision: 1,
          materialDigest: 'a'.repeat(64),
          common: [{
            id: proposalDocId,
            name: 'Staffing proposal.txt',
            kind: 'document',
            format: 'text',
            state: 'available',
            contentUrl,
            downloadUrl: null,
            size: sealedText.length,
            sha256: 'b'.repeat(64),
            mediaType: 'text/plain',
          }],
          options: [],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (method === 'GET' && path === contentUrl) {
        return new Response(sealedText, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      return new Response(JSON.stringify({ hired: ['x1'] }), { status: 201, headers: { 'content-type': 'application/json' } });
    }));

    const proposalWithMaterials = {
      id: 'pr9',
      brief: 'Start with the API.',
      materialRevision: 1,
      people: [
        { role: 'DEV-HEAD', checked: true },
        { role: 'DEV-BE', name: 'Bruno', checked: true },
      ],
    } as unknown as { id: string; brief: string; people: StaffLine[] };

    render(
      <LanguageProvider>
        <StaffCard department={DEPT} proposal={proposalWithMaterials} onCorrect={() => {}} />
      </LanguageProvider>,
    );

    const openBtn = await screen.findByRole('button', { name: /Open material: Staffing proposal\.txt/ });
    /* Edit the card before and after preview: uncheck Bruno on the card. */
    await user.click(screen.getByRole('checkbox', { name: /Bruno/ }));
    await user.click(openBtn);

    const dialog = await screen.findByRole('dialog', { name: 'Staffing proposal.txt' });
    expect(await within(dialog).findByText(/Bruno \(Backend engineer\)/)).toBeInTheDocument();
    expect(within(dialog).getByText('Original proposal. Your changes are not part of it.')).toBeInTheDocument();
    expect(within(dialog).getByText('End of document. Shown in full.')).toBeInTheDocument();
    expect(calls.filter(c => c.method === 'POST')).toEqual([]);

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Bruno/ })).not.toBeChecked();
    expect(calls.filter(c => c.method === 'POST')).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Hire (1)' }));
    await vi.waitFor(() =>
      expect(calls.find(c => c.method === 'POST')?.body).toMatchObject({
        proposalId: 'pr9',
        materialRevision: 1,
        materialDigest: 'a'.repeat(64),
      }),
    );
  });

  it('renders no fake document and keeps hiring ticks intact when GET /api/proposals/:id/materials returns 503 source_producer_unavailable', async () => {
    mockApi({
      'GET /api/departments/d2/roster': [200, ROSTER],
      'GET /api/proposals/pr9/materials': [503, { error: { code: 'unavailable', reason: 'source_producer_unavailable' } }],
    });
    const proposalWithMaterials = {
      id: 'pr9',
      brief: 'Start with the API.',
      materialRevision: 1,
      people: [
        { role: 'DEV-HEAD', checked: true },
        { role: 'DEV-BE', name: 'Bruno', checked: true },
      ],
    } as unknown as { id: string; brief: string; people: StaffLine[] };

    const { container } = render(
      <LanguageProvider>
        <StaffCard department={DEPT} proposal={proposalWithMaterials} onCorrect={() => {}} />
      </LanguageProvider>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('The original proposal document is not available right now. Try again later.');
    expect(container.querySelectorAll('.mat')).toHaveLength(0);
    expect(await screen.findByRole('button', { name: 'Hire (2)' })).toBeEnabled();
  });
});

describe('the look of the hiring card', () => {
  it('names each pick on the screen, marks the head as a badge and puts the warning on its own line with an icon', async () => {
    card(undefined, { ...ROSTER, subscriptions: [], roles: ROSTER.roles.map(r => ({ ...r, subscription: null })) });
    const heading = await screen.findByRole('heading', { name: 'Hiring for Development' });
    expect(heading.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    const warning = await screen.findByText('No subscription serves this department yet. Connect one in Subscriptions; those hired now will wait.');
    expect(warning).toHaveClass('warn-line');
    expect(warning.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    const pick = screen.getByRole('combobox', { name: 'Subscription for Backend engineer' });
    expect(within(pick.closest('label')!).getByText('Subscription')).toBeInTheDocument();
    const model = screen.getByRole('combobox', { name: 'Model for Backend engineer' });
    expect(within(model.closest('label')!).getByText('Model')).toBeInTheDocument();
    const head = within(screen.getByRole('checkbox', { name: /^Head of development/ }).closest('label')!).getByText('Head');
    expect(head).toHaveClass('badge', 'head');
  });

  it('puts Hire first, then Correct and Hide, and says Hiring… on Hire while it goes', async () => {
    let finish!: (reply: [number, unknown]) => void;
    mockApi({ 'GET /api/departments/d2/roster': [200, ROSTER], 'POST /api/departments/d2/staff': () => new Promise(resolve => { finish = resolve; }) });
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <StaffCard department={DEPT} proposal={{ id: 'pr1', brief: 'Start.', people: [{ role: 'DEV-BE', checked: true }] }} onCorrect={() => {}} onHide={() => {}} />
      </LanguageProvider>,
    );
    const hire = await screen.findByRole('button', { name: 'Hire (1)' });
    const foot = hire.parentElement!;
    expect(foot).toHaveClass('form-foot');
    expect(within(foot).getAllByRole('button')).toEqual([hire, screen.getByRole('button', { name: 'Correct in words' }), screen.getByRole('button', { name: 'Hide' })]);
    await user.click(hire);
    expect(hire).toHaveAccessibleName('Hiring…');
    expect(hire).toHaveAttribute('aria-busy', 'true');
    await act(async () => { finish([201, { hired: ['x1'] }]); });
    expect(await screen.findByText('Hired')).toBeInTheDocument();
    expect(hire).toHaveAccessibleName('Hire (1)');
  });

  it('wraps a long badge by words instead of cutting it, and keeps both picks in one row while the card is wide', () => {
    expect(decl('.staff-row .badge', 'white-space')).toBe('normal');
    expect(decl('.staff-row .badge', 'overflow-wrap')).toBe('break-word');
    expect(decl('.staff-pick', 'grid-template-columns')).toBe('repeat(2, minmax(0, 1fr))');
    expect(decl('.staff-pick select', 'height')).toBe('40px');
    expect(decl('.warn-line', 'border-inline-start')).toBe('3px solid var(--amber)');
  });
});
