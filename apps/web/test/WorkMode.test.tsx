import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, onTestFinished } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { WorkModeView } from '../src/types';
import { WorkMode } from '../src/ui/WorkMode';
import { mockApi } from './api-mock';

const t = en.dept.workMode;
const MODE = 'GET /api/departments/d1/work-mode';
const SAVE = 'PUT /api/departments/d1/work-mode';
const view = (extra: Partial<WorkModeView> = {}): WorkModeView => ({ departmentId: 'd1', workMode: 'turns', canChangeWorkMode: true, ...extra });

describe('WorkMode', () => {
  it('offers whoever may change it both ways in plain words, the stored one picked', async () => {
    mockApi({ [MODE]: [200, view()] });
    render(<WorkMode departmentId="d1" workMode="turns" />);
    const turns = await screen.findByRole('radio', { name: new RegExp(t.turns) });
    const always = screen.getByRole('radio', { name: new RegExp(t.continuous) });
    expect(turns).toBeChecked();
    expect(always).not.toBeChecked();
    expect(screen.getByRole('group', { name: t.title })).toBeInTheDocument();
    expect(screen.getByText(t.turnsHint)).toBeInTheDocument();
    expect(screen.getByText(t.continuousHint)).toBeInTheDocument();
  });

  it('saves the way picked, shown picked at once, and shows what the server kept', async () => {
    let answer!: () => void;
    const calls = mockApi({ [MODE]: [200, view()], [SAVE]: (body: unknown) => new Promise(resolve => (answer = () => resolve([200, view(body as Partial<WorkModeView>)]))) });
    render(<WorkMode departmentId="d1" workMode="turns" />);
    fireEvent.click(await screen.findByRole('radio', { name: new RegExp(t.continuous) }));
    expect(screen.getByRole('radio', { name: new RegExp(t.continuous) })).toBeChecked();
    await waitFor(() => expect(answer).toBeDefined());
    answer();
    await waitFor(() => expect(screen.getByRole('radio', { name: new RegExp(t.continuous) })).toBeChecked());
    expect(calls.filter(c => c.method === 'PUT')).toEqual([{ method: 'PUT', path: '/api/departments/d1/work-mode', body: { workMode: 'continuous' } }]);
  });

  it("shows the server's refusal in place, and the choice goes back to what is stored", async () => {
    mockApi({ [MODE]: [200, view()], [SAVE]: [403, { error: { code: 'forbidden', message: "Only this department's owner, the CEO or the CEO delegate changes its work mode.", reason: 'not_owner' } }] });
    render(<WorkMode departmentId="d1" workMode="turns" />);
    fireEvent.click(await screen.findByRole('radio', { name: new RegExp(t.continuous) }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: new RegExp(t.turns) })).toBeChecked();
  });

  it('only says how the department works to whoever may not change it', async () => {
    const calls = mockApi({ [MODE]: [200, view({ workMode: 'continuous', canChangeWorkMode: false })] });
    render(<WorkMode departmentId="d1" workMode="continuous" />);
    expect(await screen.findByText(t.isContinuous)).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('reads the mode again when the company says it changed elsewhere', async () => {
    let stored = view();
    mockApi({ [MODE]: () => [200, stored] });
    const { rerender } = render(<WorkMode departmentId="d1" workMode="turns" />);
    expect(await screen.findByRole('radio', { name: new RegExp(t.turns) })).toBeChecked();
    stored = view({ workMode: 'continuous' });
    rerender(<WorkMode departmentId="d1" workMode="continuous" />);
    await waitFor(() => expect(screen.getByRole('radio', { name: new RegExp(t.continuous) })).toBeChecked());
  });

  /* Russian writes "е" for "\u0451" and no long dash. */
  it('speaks Russian in plain words', async () => {
    localStorage.setItem('hh-lang', 'ru');
    onTestFinished(() => localStorage.removeItem('hh-lang'));
    mockApi({ [MODE]: [200, view({ canChangeWorkMode: false })] });
    render(<LanguageProvider><WorkMode departmentId="d1" workMode="turns" /></LanguageProvider>);
    expect(await screen.findByText(ru.dept.workMode.isTurns)).toBeInTheDocument();
    for (const text of Object.values(ru.dept.workMode)) expect(text).not.toMatch(/[\u0401\u0451\u2014]/);
  });
});
