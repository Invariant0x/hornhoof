import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { MergeCard } from '../src/ui/MergeCard';
import type { MergeConflict, MergeDecision } from '../src/types';
import { mockApi } from './api-mock';

const MERGE: MergeDecision = { id: 'm1', label: 'the database from before the restore of 10 Nov 08:00 UTC', after: '2026-11-10T08:00:00.000Z', open: 3 };
const conflict = (over: Partial<MergeConflict>): MergeConflict => ({
  id: 'c1', merge: 'm1', label: MERGE.label, table: 'people', topic: 'people', what: 'Maria (maria@acme.test)', kind: 'differs', cols: ['name', 'password_hash'],
  here: { name: '"Maria Here"', password_hash: '(hidden)' }, there: { name: '"Maria There"', password_hash: '(hidden)' }, at: '2026-11-10T09:00:00.000Z', task: null, whose: 'ceo', picked: null, ...over,
});
const CONFLICTS = [
  conflict({}),
  conflict({ id: 'c2', what: 'Zed (zed@acme.test)', cols: ['status'], here: { status: '"active"' }, there: { status: '"disabled"' } }),
  conflict({ id: 'c3', table: 'machines', topic: 'machines', what: 'marat-mac', kind: 'changed_removed', cols: [], here: null, there: { hostname: '"marat-mac"' } }),
];
const PICKED = { settled: 1, here: 0, there: 1, refused: [], tasks: [] };

afterEach(() => vi.unstubAllGlobals());

function shown(merge: MergeDecision = MERGE, onChange = vi.fn(), onFailure = vi.fn()) {
  render(<LanguageProvider><MergeCard merge={merge} onChange={onChange} onFailure={onFailure} /></LanguageProvider>);
  return { onChange, onFailure };
}

describe("the CEO's card of a merge", () => {
  it('shows both values and settles them', async () => {
    const calls = mockApi({ 'GET /api/merges/m1/conflicts': [200, { conflicts: CONFLICTS }], 'POST /api/merges/pick': [200, PICKED] });
    const user = userEvent.setup();
    const { onChange } = shown();
    const card = await screen.findByRole('region', { name: /^What came after / });
    expect(card).toHaveTextContent('3 changes about people, access, plans, machines or protected records need you.');
    /* A group for each table, under the name of what it is about. */
    const people = within(card).getByRole('group', { name: 'People' });
    const maria = within(people).getByRole('group', { name: 'Maria (maria@acme.test)' });
    expect(within(maria).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['', 'Here', 'There']);
    expect(within(maria).getByRole('row', { name: 'name "Maria Here" "Maria There"' })).toBeInTheDocument();
    /* A secret is never shown, on either side. */
    expect(within(maria).getByRole('row', { name: 'password_hash (hidden) (hidden)' })).toBeInTheDocument();
    /* A row only one side has. */
    const machines = within(card).getByRole('group', { name: 'Machines' });
    expect(within(machines).getByRole('row', { name: 'hostname nothing "marat-mac"' })).toBeInTheDocument();
    await user.click(within(maria).getByRole('button', { name: 'Take there' }));
    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', path: '/api/merges/pick', body: { ids: ['c1'], take: 'there' } }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    await user.click(within(within(people).getByRole('group', { name: 'Zed (zed@acme.test)' })).getByRole('button', { name: 'Keep here' }));
    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', path: '/api/merges/pick', body: { ids: ['c2'], take: 'here' } }));
    /* All of a table at once. */
    await user.click(within(people).getByRole('button', { name: 'Keep all here' }));
    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', path: '/api/merges/pick', body: { merge: 'm1', table: 'people', take: 'here' } }));
    await user.click(within(machines).getByRole('button', { name: 'Take all from there' }));
    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', path: '/api/merges/pick', body: { merge: 'm1', table: 'machines', take: 'there' } }));
    expect(onChange).toHaveBeenCalledTimes(4);
    /* The list is read again after each. */
    expect(calls.filter(call => call.method === 'GET' && call.path === '/api/merges/m1/conflicts')).toHaveLength(5);
  });

  it('names any other source by its own words, and says so when something could not be taken', async () => {
    mockApi({
      'GET /api/merges/m1/conflicts': [200, { conflicts: [CONFLICTS[0]] }],
      'POST /api/merges/pick': [200, { settled: 0, here: 0, there: 0, refused: [{ id: 'c1', why: "Only the machine's owner opens computer access, on its card." }], tasks: [] }],
    });
    const user = userEvent.setup();
    shown({ ...MERGE, label: 'marat-mac', after: null, open: 1 });
    const card = await screen.findByRole('region', { name: 'marat-mac' });
    expect(card).toHaveTextContent('1 change about people, access, plans, machines or protected records needs you.');
    await user.click(await within(card).findByRole('button', { name: 'Take there' }));
    expect(await within(card).findByText("1 could not be taken and stays as it is here. Only the machine's owner opens computer access, on its card.")).toBeInTheDocument();
  });

  it('hands a failure to the screen', async () => {
    mockApi({ 'GET /api/merges/m1/conflicts': [403, { error: { code: 'forbidden', message: 'Only the CEO settles these, from his own session.', reason: 'not_owner_session' } }] });
    const { onFailure } = shown();
    await waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
  });
});
