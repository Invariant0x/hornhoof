import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Notebook } from '../src/ui/Notebook';
import { mockApi } from './api-mock';
import { fakeStream } from './fake-stream';

const NOTES = [
  { number: 1, text: 'Commits are made by Ivan only.', by: { kind: 'person', id: 'p1', name: 'Ivan' }, updatedAt: '2026-10-31T01:00:00Z' },
  { number: 3, text: 'Turns stay small.', by: { kind: 'orchestrator' }, updatedAt: '2026-10-31T02:00:00Z' },
];

function show(routes: Record<string, unknown> = {}) {
  const calls = mockApi({ 'GET /api/notebook': [200, { notes: NOTES }], ...(routes as Record<string, [number, unknown]>) });
  render(
    <LanguageProvider>
      <Notebook />
    </LanguageProvider>,
  );
  return calls;
}

describe('the company notebook', () => {
  it('lists the notes with who wrote each', async () => {
    show();
    const list = await screen.findByRole('list', { name: 'Notebook' });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(first).toHaveTextContent('#1Commits are made by Ivan only.Ivan');
    expect(second).toHaveTextContent('#3Turns stay small.Orchestrator');
  });

  it('adds, changes and removes notes', async () => {
    const user = userEvent.setup();
    const calls = show({
      'POST /api/notebook': [201, { note: { number: 4, text: 'One question at a time.' } }],
      'PATCH /api/notebook/3': [200, { note: { number: 3, text: 'Turns stay very small.' } }],
      'DELETE /api/notebook/1': [204, undefined],
    });
    await screen.findByText('Turns stay small.');
    await user.type(screen.getByRole('textbox', { name: 'New note' }), 'One question at a time.');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(screen.getByRole('button', { name: 'Change note #3' }));
    const edit = screen.getByRole('textbox', { name: 'Note #3' });
    await user.clear(edit);
    await user.type(edit, 'Turns stay very small.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(screen.getByRole('button', { name: 'Remove note #1' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Do you really want to delete this note?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(calls.filter(c => c.method !== 'GET')).toEqual([
      { method: 'POST', path: '/api/notebook', body: { text: 'One question at a time.' } },
      { method: 'PATCH', path: '/api/notebook/3', body: { text: 'Turns stay very small.' } },
      { method: 'DELETE', path: '/api/notebook/1', body: undefined },
    ]);
  });

  it('confirms before deleting a note and keeps failures in the dialog', async () => {
    const user = userEvent.setup();
    let fail = true;
    const calls = show({
      'DELETE /api/notebook/1': () => (fail ? [500, { error: { code: 'internal', message: 'Cannot delete note.' } }] : [204, undefined]),
    });
    await screen.findByText('Turns stay small.');
    const remove = screen.getByRole('button', { name: 'Remove note #1' });
    await user.click(remove);
    expect(calls.filter(c => c.method === 'DELETE')).toEqual([]);
    const dialog = screen.getByRole('alertdialog', { name: 'Do you really want to delete this note?' });
    expect(dialog).toHaveAccessibleDescription('Note #1 will be deleted from the notebook.');
    expect(dialog.querySelector('bdi')).toHaveTextContent('#1');
    expect(dialog).toHaveTextContent('This cannot be undone.');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(calls.filter(c => c.method === 'DELETE')).toEqual([]);

    await user.click(remove);
    const again = screen.getByRole('alertdialog');
    await user.click(within(again).getByRole('button', { name: 'Delete' }));
    expect(await within(again).findByRole('alert')).toHaveTextContent('Cannot delete note.');

    fail = false;
    await user.click(within(again).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(2);
  });

  it('says when the notebook could not be read, and reads it again on Try again', async () => {
    const user = userEvent.setup();
    let down = true;
    mockApi({ 'GET /api/notebook': () => (down ? [503, { error: { code: 'unavailable', message: 'Hornhoof is busy.' } }] : [200, { notes: NOTES }]) });
    render(
      <LanguageProvider>
        <Notebook />
      </LanguageProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read the notebook. Hornhoof is busy.');
    expect(screen.queryByText('The notebook is empty so far.')).not.toBeInTheDocument();
    down = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Turns stay small.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reads the notes again when the stream says the notebook changed', async () => {
    const stream = fakeStream();
    const calls = show();
    await screen.findByText('Turns stay small.');
    stream.send({ type: 'notebook', spot: { departmentId: 'd2' } });
    stream.send({ type: 'notebook', spot: { departmentId: null } });
    await expect.poll(() => calls.filter(c => c.path === '/api/notebook').length).toBe(2);
  });

  it("keeps a department's notebook for its head, and reads it again only when that one changed", async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    const calls = mockApi({
      'GET /api/departments/d2/notebook': [200, { notes: [{ number: 1, text: 'Tests first.', by: { kind: 'agent', id: 'b0', name: 'Dana' }, updatedAt: '2026-10-31T02:00:00Z' }] }],
      'POST /api/departments/d2/notebook': [201, { note: { number: 2, text: 'Small commits.' } }],
    });
    render(
      <LanguageProvider>
        <Notebook departmentId="d2" />
      </LanguageProvider>,
    );
    expect(await screen.findByRole('listitem')).toHaveTextContent('#1Tests first.Dana');
    await user.type(screen.getByRole('textbox', { name: 'New note' }), 'Small commits.');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(calls.find(c => c.method === 'POST')).toEqual({ method: 'POST', path: '/api/departments/d2/notebook', body: { text: 'Small commits.' } });
    const reads = () => calls.filter(c => c.method === 'GET').length;
    const before = reads();
    stream.send({ type: 'notebook', spot: { departmentId: 'd9' } });
    stream.send({ type: 'notebook', spot: { departmentId: null } });
    stream.send({ type: 'notebook', spot: { departmentId: 'd2' } });
    await expect.poll(reads).toBe(before + 1);
  });

  it('shows loading before the notes arrive', async () => {
    show({ 'GET /api/notebook': () => new Promise(() => {}) });
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
  });

  it('announces saving until the answer arrives', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const answer = new Promise<[number, { note: { number: number; text: string } }]>(resolve => {
      release = () => resolve([200, { note: { number: 3, text: 'Turns stay very small.' } }]);
    });
    show({ 'PATCH /api/notebook/3': () => answer });
    await screen.findByText('Turns stay small.');
    await user.click(screen.getByRole('button', { name: 'Change note #3' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saving');
    expect(screen.getByRole('region', { name: 'Notebook' })).toHaveAttribute('aria-busy', 'true');
    release();
    await expect.poll(() => screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('region', { name: 'Notebook' })).toHaveAttribute('aria-busy', 'false');
  });

  it('shows in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    mockApi({ 'GET /api/notebook': [200, { notes: [] }] });
    render(
      <LanguageProvider>
        <Notebook />
      </LanguageProvider>,
    );
    expect(await screen.findByText('Блокнот пока пуст.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Новая запись' })).toBeInTheDocument();
  });
});
