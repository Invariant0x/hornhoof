import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Machines } from '../src/screens/Machines';
import type { ConnectionHistory, MachineView } from '../src/types';
import { accessView, MACHINES, ME, mockApi, SUBS } from './api-mock';
import { decl } from './css';

/* The lower part of a machine's card (#1027): under the top, which stays as it was, three blocks of their own with a
   heading each, what the machine is for the company's server, what it is and who may reach it, and what its owner sets,
   then the connection to the server. */

const UNTIL = new Date(Date.now() + 86_400_000).toISOString();
const held = (over: object) => ({ number: null, why: null, pin: null, unfit: null, copy: null, leftAt: null, ...over });
/* dev-laptop of the CEO: second in line with an up-to-date copy, its programs, open to the orchestrator, keeping backups,
   and joined before machines had a core. */
const LAPTOP: MachineView = {
  ...MACHINES[0]!,
  data: held({ number: 2, why: 'always.best_link', copy: { line: 'ready' } }),
  programs: [{ id: 'claude', version: '2.1.0', updating: false, failed: false }],
  access: accessView('dev-laptop', { until: UNTIL, machine: { id: 'm1' } }),
  keepsBackups: true,
  heldBackups: 2,
  needsCore: true,
} as MachineView;
const QUIET: ConnectionHistory = { summary: { drops: 0, averageMs: null, cause: null }, events: [] };

const LOWER = {
  en: ['Server and data copy', 'System, programs and access', 'Settings and actions', 'Connection to the server'],
  ru: ['Сервер и копия данных', 'Система, программы и доступ', 'Настройки и действия', 'Связь с сервером'],
};

function show(language: 'en' | 'ru' = 'en', machine: MachineView = LAPTOP, more: Parameters<typeof mockApi>[0] = {}) {
  localStorage.setItem('hh-lang', language);
  const calls = mockApi({
    'GET /api/subscriptions': [200, { subscriptions: SUBS }],
    'GET /api/machines': [200, { machines: [machine], builtin: null, priority: true }],
    'GET /api/machines/m1/connections': [200, QUIET],
    ...more,
  });
  render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
  return calls;
}

async function open(name = 'dev-laptop') {
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^(Open the card of |Открыть карточку )${name}$`) }));
  return screen.getByRole('article', { name });
}

const block = (card: HTMLElement, name: string) => within(card).getByRole('region', { name });

afterEach(() => localStorage.clear());

describe("the lower part of a machine's card", () => {
  it.each(['en', 'ru'] as const)('stands in three blocks of its own under the top, each with its heading, then the connection, in %s', async language => {
    show(language);
    const card = await open();
    await within(card).findByText(language === 'en' ? 'Stable' : 'Стабильна');
    const names = within(card).getAllByRole('region').map(region => region.getAttribute('aria-label') ?? region.querySelector('h4')?.textContent);
    expect(names.filter(name => LOWER[language].includes(name ?? ''))).toEqual(LOWER[language]);
  });

  it('leaves the top as it was: the resources under About the machine, and only the plans on the right', async () => {
    show();
    const card = await open();
    const top = within(card).getByRole('heading', { name: 'About the machine' }).closest('section')!;
    expect(within(top).getAllByRole('heading').map(heading => heading.textContent)).toEqual(['About the machine', 'Resources']);
    expect(top.querySelectorAll('.gauge')).toHaveLength(4);
    const side = within(card).getByRole('heading', { name: 'Plans on this machine' }).closest('section')!;
    expect(within(side).getAllByRole('heading').map(heading => heading.textContent)).toEqual(['Plans on this machine']);
    expect(within(side).queryByRole('checkbox')).toBeNull();
    expect(within(side).queryByRole('button')).toBeNull();
  });

  it("puts the server's order, the choice of the place and the copy in the first block", async () => {
    show();
    const role = block(await open(), 'Server and data copy');
    expect(within(role).getByRole('heading', { name: 'Priority' })).toBeInTheDocument();
    expect(within(role).getByRole('radiogroup', { name: 'Priority' })).toBeInTheDocument();
    expect(within(role).getByText('2')).toBeInTheDocument();
    const copy = within(role).getByRole('heading', { name: 'Data copy' }).closest('section')!;
    expect(copy).toHaveTextContent('Copy: up to date');
  });

  it('puts the owner, the system, the programs and the access in the second block', async () => {
    show();
    const system = block(await open(), 'System, programs and access');
    const fact = (label: string) => within(system).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;
    expect(fact('Owner')).toBe('Ivan');
    expect(fact('System')).toBe('macOS, arm64');
    expect(within(system).getByRole('heading', { name: 'Agent programs' })).toBeInTheDocument();
    expect(fact('Claude Code')).toBe('2.1.0');
    expect(within(system).getByRole('button', { name: 'Update programs' })).toBeInTheDocument();
    expect(within(system).getByRole('heading', { name: 'Computer access' })).toBeInTheDocument();
    expect(within(system).getByText(/^Access to dev-laptop is open until .+\.$/)).toBeInTheDocument();
    expect(within(system).getByRole('button', { name: 'Close access' })).toBeInTheDocument();
  });

  it("keeps every setting and action of the owner in the third block, the question before Disconnect too", async () => {
    show();
    const owner = block(await open(), 'Settings and actions');
    expect(within(owner).getByRole('checkbox', { name: "Lend dev-laptop to the company's test runs" })).toBeChecked();
    expect(within(owner).getByRole('checkbox', { name: "Keep the company's backups on dev-laptop" })).toBeChecked();
    expect(within(owner).getByText('Backups held: 2')).toBeInTheDocument();
    const actions = within(owner).getAllByRole('button').map(button => button.textContent);
    expect(actions).toEqual(['Add my plan', 'Make dev-laptop a full machine of the company', 'Disconnect']);
    await userEvent.setup().click(within(owner).getByRole('button', { name: 'Disconnect dev-laptop' }));
    expect(within(owner).getByText(/^Disconnect dev-laptop\?/)).toBeInTheDocument();
    expect(within(owner).getByRole('button', { name: 'Yes, disconnect' })).toBeInTheDocument();
  });

  it("puts the owner's buttons in one group under the settings: the main one, the next, Disconnect last (#1036)", async () => {
    show();
    const owner = block(await open(), 'Settings and actions');
    const facts = owner.querySelector('dl.facts')!;
    const groups = owner.querySelectorAll('.entry-actions');
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(facts.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...group.children].map(button => button.textContent)).toEqual(['Add my plan', 'Make dev-laptop a full machine of the company', 'Disconnect']);
    expect(group.lastElementChild).toHaveClass('danger');
  });

  it.each(['add', 'core'] as const)('gives Cancel under the %s command a group of its own on the end edge, a button of 44 px', async kind => {
    const command = { id: 'c1', kind, plans: [], machineId: 'm1', machine: 'dev-laptop', command: 'curl -fsSL https://hq.acme.com/install.sh | bash', expiresAt: UNTIL };
    show('en', LAPTOP, { 'GET /api/nodes/commands': [200, { commands: [command] }] });
    /* A machine with a command still open stands open by itself. */
    const card = await screen.findByRole('article', { name: 'dev-laptop' });
    const cancel = await within(card).findByRole('button', { name: 'Cancel' });
    expect(cancel.closest('.add-plan')).not.toBeNull();
    expect(cancel.parentElement).toHaveClass('entry-actions');
    expect(cancel).toHaveClass('btn', 'ghost');
    expect(cancel).not.toHaveClass('small');
  });

  it('writes the blocks in plain lines, with no note striped at its side, and gives their buttons a group of their own', async () => {
    show();
    const card = await open();
    for (const name of LOWER.en.slice(0, 3)) {
      const region = block(card, name);
      expect(region.querySelector('.machine-note'), name).toBeNull();
      for (const button of within(region).queryAllByRole('button')) expect(button.parentElement?.classList.contains('entry-actions'), `${name}: ${button.textContent}`).toBe(true);
    }
  });

  it('gives the choices and switches of the blocks 44 px, and lays the blocks out by the width of the card', () => {
    expect(decl('.mc-blk .pm-opt', 'min-block-size')).toBe('44px');
    expect(decl('.mc-blk .lend', 'min-block-size')).toBe('44px');
    expect(decl('.mc-blk .pmode select', 'block-size')).toBe('44px');
    expect(decl('.mc-blocks', 'grid-column')).toBe('1 / -1');
    expect(decl('.mc-blocks', 'grid-template-columns', 'card (min-width: 700px)')).toBe('repeat(2, minmax(0, 1fr))');
    expect(decl('.mc-blocks', 'grid-template-columns', 'card (min-width: 1180px)')).toBe('repeat(3, minmax(0, 1fr))');
  });

  it('says nothing of the server where the machine has no part in it, and keeps the other two blocks', async () => {
    show('en', { ...MACHINES[1]!, owner: { id: 'p1', name: 'Ivan' }, online: true } as MachineView);
    const card = await open('build-box');
    expect(within(card).queryByRole('region', { name: 'Server and data copy' })).toBeNull();
    expect(block(card, 'System, programs and access')).toBeInTheDocument();
    expect(block(card, 'Settings and actions')).toBeInTheDocument();
  });
});

/* How many agents' turns a machine runs at once (#1212): its owner, the CEO or the CEO delegate types it into the third
   block and it is kept on Enter or on leaving the field; anyone else reads it. */
describe("a machine's limit of turns at once", () => {
  const NAMES = { en: 'Turns at once on dev-laptop, empty for no limit', ru: 'Ходов одновременно на dev-laptop, пусто значит без предела' };
  const puts = (calls: ReturnType<typeof show>) => calls.filter(c => c.method === 'PUT' && c.path === '/api/machines/m1/turn-limit').map(c => c.body);

  it.each(['en', 'ru'] as const)('is set as a whole number, kept on Enter and on leaving the field, and emptied for no limit (%s)', async language => {
    const calls = show(language, { ...LAPTOP, turnLimit: null, turnsWaiting: 0 } as MachineView, { 'PUT /api/machines/m1/turn-limit': (body: unknown) => [200, { turnLimit: (body as { limit: number | null }).limit }] });
    const owner = block(await open(), LOWER[language][2]);
    const field = within(owner).getByRole('spinbutton', { name: NAMES[language] });
    expect(field).toHaveValue(null);
    expect(within(owner).getByText(language === 'en' ? /^Empty for no limit\. Kept on Enter/ : /^Пусто значит без предела\. Сохраняется по Enter/)).toHaveAttribute('dir', 'auto');
    const user = userEvent.setup();
    await user.type(field, '2{Enter}');
    await screen.findByDisplayValue('2');
    await user.clear(field);
    await user.type(field, '3');
    await user.tab();
    await user.clear(field);
    await user.type(field, '{Enter}');
    expect(puts(calls)).toEqual([{ limit: 2 }, { limit: 3 }, { limit: null }]);
  });

  it.each([['0'], ['1.5'], ['-2']])('sends nothing for %s and says what it takes', async typed => {
    const calls = show('en', { ...LAPTOP, turnLimit: 4 } as MachineView);
    const owner = block(await open(), 'Settings and actions');
    const field = within(owner).getByRole('spinbutton', { name: NAMES.en });
    expect(field).toHaveValue(4);
    const user = userEvent.setup();
    await user.clear(field);
    await user.type(field, `${typed}{Enter}`);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(within(owner).getByText('A whole number of 1 or more, or empty for no limit. Nothing was changed.')).toBeInTheDocument();
    expect(puts(calls)).toEqual([]);
  });

  it('shows how many turns wait for a place there, and lets a person who is neither its owner nor the CEO only read it, in either direction', async () => {
    document.documentElement.dir = 'rtl';
    try {
      localStorage.setItem('hh-lang', 'ru');
      mockApi({
        'GET /api/subscriptions': [200, { subscriptions: SUBS }],
        'GET /api/machines': [200, { machines: [{ ...LAPTOP, turnLimit: 2, turnsWaiting: 3 }], builtin: null, priority: false }],
        'GET /api/machines/m1/connections': [200, QUIET],
      });
      const wes = { ...ME, person: { ...ME.person, id: 'p9', name: 'Wes', title: 'Lead', isOwner: false } };
      render(<LanguageProvider><Machines me={wes} /></LanguageProvider>);
      const owner = block(await open(), LOWER.ru[2]);
      expect(within(owner).queryByRole('spinbutton')).toBeNull();
      expect(within(owner).getByText('Ждут места: 3')).toBeInTheDocument();
      expect(owner.textContent).toContain('Ходов одновременно');
    } finally {
      document.documentElement.dir = '';
    }
  });

  it('keeps the field a touch high, its colours from the theme and its sides logical, so it reads the same right to left', () => {
    expect(decl('.turn-limit input', 'min-block-size')).toBe('44px');
    expect(decl('.turn-limit input', 'inline-size')).toBe('7em');
    expect(decl('.turn-limit input', 'background-color')).toBe('var(--surface2)');
    expect(decl('.turn-limit input', 'border')).toBe('1px solid var(--line2)');
    expect(decl('.turn-limit input', 'padding-inline')).toBe('12px');
    expect(decl('.turn-limit input', 'color')).toBe('var(--ink)');
    expect(decl('.turn-limit .bad', 'color')).toBe('var(--pink-ink)');
    expect(decl('.turn-limit input', 'width')).toBeUndefined();
    expect(decl('.turn-limit', 'margin-left')).toBeUndefined();
  });
});
