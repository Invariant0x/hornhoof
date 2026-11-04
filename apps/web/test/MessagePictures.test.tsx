import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { AgentWindow } from '../src/screens/AgentWindow';
import type { EventView } from '../src/types';
import { CARD, ME, mockApi, ORG } from './api-mock';

/* xterm needs a real canvas; the window only has to know the terminal is there. */
vi.mock('../src/ui/AgentTerminal', () => ({
  AgentTerminal: () => (
    <div data-testid="live-terminal">
      <textarea className="xterm-helper-textarea" aria-label="Terminal input" />
    </div>
  ),
}));

const AGENT = '/api/agents/orchestrator';
const READY = { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 };
const TERMINAL = { ...READY, terminal: true, canType: true };
const LINE = 'Write to the orchestrator';

const png = (name = 'screen.png', size = 64) => new File([new Uint8Array(size)], name, { type: 'image/png' });
const dragged = (...files: File[]) => ({ dataTransfer: { types: ['Files'], files, dropEffect: 'none' } });
const copied = (files: File[], text = '') => ({ clipboardData: { files, types: [...(files.length ? ['Files'] : []), ...(text ? ['text/plain'] : [])], getData: (type: string) => (type === 'text/plain' ? text : '') } });
const uploaded = (id: string, name = 'screen.png') => [201, { id, name }] as [number, unknown];

function open(routes: Record<string, unknown> = {}, state: object = READY, events: EventView[] = []) {
  const calls = mockApi({
    [`GET ${AGENT}`]: [200, { ...CARD, id: ORG.orchestrator!.id, kind: 'orchestrator', name: 'Orchestrator' }],
    [`GET ${AGENT}/events?after=0`]: [200, { events, state }],
    [`POST ${AGENT}/start`]: [200, { started: false }],
    [`POST ${AGENT}/messages`]: [202, { jobId: 'j2' }],
    ...(routes as Record<string, [number, unknown]>),
  });
  const { unmount } = render(
    <LanguageProvider>
      <AgentWindow me={ME} org={ORG} agentId="orchestrator" onClose={vi.fn()} />
    </LanguageProvider>,
  );
  const messages = () => calls.filter(c => c.method === 'POST' && c.path === `${AGENT}/messages`).map(c => c.body);
  const uploads = () => calls.filter(c => c.method === 'POST' && c.path.startsWith(`${AGENT}/pictures`)).map(c => c.path);
  return { calls, messages, uploads, unmount };
}

const windowBox = () => screen.getByRole('complementary');
/* A file takes a moment to be looked at before it shows, so that nothing shows yet proves little. */
const settled = () => act(() => new Promise(done => setTimeout(done)));
const line = () => screen.findByRole('textbox', { name: LINE });
const preview = (name = 'screen.png') => screen.findByRole('img', { name });
const remove = (name = 'screen.png') => screen.findByRole('button', { name: `Remove ${name}` });

beforeEach(() => {
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:preview-${++n}`);
  URL.revokeObjectURL = vi.fn();
});

describe('a picture dragged into the window', () => {
  it('shows where to drop it while it is dragged, and not after it leaves', async () => {
    open();
    await line();
    expect(screen.queryByText(en.window.dropPictures)).not.toBeInTheDocument();
    fireEvent.dragEnter(windowBox(), dragged());
    expect(screen.getByText(en.window.dropPictures)).toBeInTheDocument();
    fireEvent.dragEnter(within(windowBox()).getByRole('textbox', { name: LINE }), dragged());
    fireEvent.dragLeave(windowBox(), dragged());
    expect(screen.getByText(en.window.dropPictures)).toBeInTheDocument();
    fireEvent.dragLeave(screen.getByRole('textbox', { name: LINE }), dragged());
    expect(screen.queryByText(en.window.dropPictures)).not.toBeInTheDocument();
  });

  it('counts its way in and out afresh after a drop', async () => {
    open();
    await line();
    fireEvent.dragEnter(windowBox(), dragged());
    fireEvent.drop(windowBox(), dragged(png()));
    await preview();
    fireEvent.dragEnter(windowBox(), dragged());
    expect(screen.getByText(en.window.dropPictures)).toBeInTheDocument();
    fireEvent.dragLeave(windowBox(), dragged());
    expect(screen.queryByText(en.window.dropPictures)).not.toBeInTheDocument();
  });

  it('says nothing for a selection of text being dragged, and leaves it to the page', async () => {
    open();
    await line();
    fireEvent.dragEnter(windowBox(), { dataTransfer: { types: ['text/plain'], files: [] } });
    expect(screen.queryByText(en.window.dropPictures)).not.toBeInTheDocument();
    expect(fireEvent.dragOver(windowBox(), { dataTransfer: { types: ['text/plain'], files: [] } })).toBe(true);
  });

  it('goes with the words of the message, once, as raw bytes', async () => {
    const user = userEvent.setup();
    const { calls, messages } = open({ [`POST ${AGENT}/pictures?name=screen.png`]: uploaded('pic1') });
    await line();
    const over = dragged();
    expect(fireEvent.dragOver(windowBox(), over)).toBe(false);
    expect(over.dataTransfer.dropEffect).toBe('copy');
    fireEvent.dragEnter(windowBox(), dragged());
    fireEvent.drop(windowBox(), dragged(png()));
    expect(await preview()).toHaveAttribute('src', 'blob:preview-1');
    expect(screen.queryByText(en.window.dropPictures)).not.toBeInTheDocument();
    expect(await line()).toHaveFocus();
    await user.type(await line(), 'Look at this{Enter}');
    await waitFor(() => expect(messages()).toEqual([{ text: 'Look at this', pictures: ['pic1'] }]));
    await waitFor(() => expect(screen.queryByRole('img', { name: 'screen.png' })).not.toBeInTheDocument());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    expect(calls.findIndex(c => c.path.includes('/pictures'))).toBeLessThan(calls.findIndex(c => c.path.endsWith('/messages')));
    const sent = vi.mocked(fetch).mock.calls.find(([path]) => String(path).includes('/pictures'))![1]!;
    expect(sent.body).toBeInstanceOf(File);
    expect(sent.headers).toEqual({ 'content-type': 'application/octet-stream' });
  });

  it('goes alone, without words, by the button as well', async () => {
    const user = userEvent.setup();
    const { messages } = open({ [`POST ${AGENT}/pictures?name=screen.png`]: uploaded('pic1') });
    await line();
    expect(screen.queryByRole('button', { name: en.window.sendPictures })).not.toBeInTheDocument();
    fireEvent.drop(windowBox(), dragged(png()));
    await preview();
    await user.click(screen.getByRole('button', { name: en.window.sendPictures }));
    await waitFor(() => expect(messages()).toEqual([{ text: '', pictures: ['pic1'] }]));
  });

  it('names the file in the address, whatever its name holds', async () => {
    const user = userEvent.setup();
    const { messages, uploads } = open({ [`POST ${AGENT}/pictures?name=my%20shot%20%231.png`]: uploaded('pic1', 'my shot #1.png') });
    await line();
    fireEvent.drop(windowBox(), dragged(png('my shot #1.png')));
    await preview('my shot #1.png');
    await user.type(await line(), '{Enter}');
    await waitFor(() => expect(messages()).toHaveLength(1));
    expect(uploads()).toEqual([`${AGENT}/pictures?name=my%20shot%20%231.png`]);
  });

  it('lets go of its preview when the window closes', async () => {
    const { unmount } = open();
    await line();
    fireEvent.drop(windowBox(), dragged(png()));
    await preview();
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
  });

  it('holds back no message that has no picture', async () => {
    const user = userEvent.setup();
    let arrive = () => {};
    let n = 0;
    const { messages } = open({ [`POST ${AGENT}/messages`]: () => (++n === 1 ? new Promise(done => { arrive = () => done([202, { jobId: 'j2' }]); }) : [202, { jobId: 'j3' }]) });
    await user.type(await line(), 'First{Enter}');
    await user.type(await line(), 'Second{Enter}');
    await waitFor(() => expect(messages()).toEqual([{ text: 'First' }, { text: 'Second' }]));
    arrive();
  });

  it('takes several at once and any of them can be taken back before sending', async () => {
    const user = userEvent.setup();
    const { messages, uploads } = open({ [`POST ${AGENT}/pictures?name=a.png`]: uploaded('a', 'a.png'), [`POST ${AGENT}/pictures?name=c.png`]: uploaded('c', 'c.png') });
    await line();
    fireEvent.drop(windowBox(), dragged(png('a.png'), png('b.png'), png('c.png')));
    await preview('c.png');
    await user.click(await remove('b.png'));
    expect(screen.queryByRole('img', { name: 'b.png' })).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-2');
    expect(await line()).toHaveFocus();
    await user.type(await line(), 'Both{Enter}');
    await waitFor(() => expect(messages()).toEqual([{ text: 'Both', pictures: ['a', 'c'] }]));
    expect(uploads()).toEqual([`${AGENT}/pictures?name=a.png`, `${AGENT}/pictures?name=c.png`]);
  });

  it('opens the line under the terminal for the one who types into it, and goes back to the terminal after sending', async () => {
    const user = userEvent.setup();
    const { messages } = open({ [`POST ${AGENT}/pictures?name=screen.png`]: uploaded('pic1') }, TERMINAL);
    expect(await screen.findByTestId('live-terminal')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: LINE })).not.toBeInTheDocument();
    fireEvent.drop(windowBox(), dragged(png()));
    await preview();
    expect(await line()).toHaveFocus();
    await user.type(await line(), 'Here{Enter}');
    await waitFor(() => expect(messages()).toEqual([{ text: 'Here', pictures: ['pic1'] }]));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: LINE })).not.toBeInTheDocument());
    expect(screen.getByRole('textbox', { name: 'Terminal input' })).toHaveFocus();
  });

  it('keeps the line while the owner of the terminal has words in it, with the last picture taken back', async () => {
    const user = userEvent.setup();
    open({}, TERMINAL);
    await screen.findByTestId('live-terminal');
    fireEvent.drop(windowBox(), dragged(png()));
    await user.type(await line(), 'Words');
    await user.click(await remove());
    expect(await line()).toHaveValue('Words');
  });

  it('gives the keys back to the terminal when the last picture is taken back with no words', async () => {
    const user = userEvent.setup();
    open({}, TERMINAL);
    await screen.findByTestId('live-terminal');
    fireEvent.drop(windowBox(), dragged(png()));
    await user.click(await remove());
    await waitFor(() => expect(screen.queryByRole('textbox', { name: LINE })).not.toBeInTheDocument());
    expect(screen.getByRole('textbox', { name: 'Terminal input' })).toHaveFocus();
  });
});

describe('a picture pasted into the window', () => {
  it('comes from the line, from the terminal and from nowhere in particular, and the program never sees it', async () => {
    open({}, TERMINAL);
    const terminal = await screen.findByRole('textbox', { name: 'Terminal input' });
    const seen = vi.fn();
    terminal.addEventListener('paste', seen);
    expect(fireEvent.paste(terminal, copied([png('from-terminal.png')]))).toBe(false);
    expect(await preview('from-terminal.png')).toBeInTheDocument();
    expect(seen).not.toHaveBeenCalled();
    expect(fireEvent.paste(await line(), copied([png('from-line.png')]))).toBe(false);
    expect(await preview('from-line.png')).toBeInTheDocument();
    expect(fireEvent.paste(document.body, copied([png('from-page.png')]))).toBe(false);
    expect(await preview('from-page.png')).toBeInTheDocument();
  });

  it('leaves text to whatever takes it, with a picture in the clipboard or without', async () => {
    open();
    const field = await line();
    expect(fireEvent.paste(field, copied([], 'just words'))).toBe(true);
    expect(fireEvent.paste(field, copied([png()], 'a cell of a table'))).toBe(true);
    expect(screen.queryByRole('img', { name: 'screen.png' })).not.toBeInTheDocument();
  });

  it('leaves a file that is no picture alone', async () => {
    open();
    expect(fireEvent.paste(await line(), copied([new File(['x'], 'report.pdf', { type: 'application/pdf' })]))).toBe(true);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('is not taken from a field of a panel or of a card, or dropped on a panel', async () => {
    open();
    await line();
    const panel = document.querySelector('.agent-task-slot')!;
    const comment = panel.appendChild(document.createElement('textarea'));
    expect(fireEvent.paste(comment, copied([png()]))).toBe(true);
    const card = document.querySelector('.agent-conversation')!.appendChild(document.createElement('input'));
    expect(fireEvent.paste(card, copied([png()]))).toBe(true);
    fireEvent.dragEnter(comment, dragged());
    expect(screen.queryByText(en.window.dropPictures)).not.toBeInTheDocument();
    const over = dragged();
    fireEvent.dragOver(comment, over);
    expect(over.dataTransfer.dropEffect).toBe('none');
    fireEvent.dragEnter(windowBox(), dragged());
    fireEvent.dragLeave(comment, dragged());
    expect(screen.getByText(en.window.dropPictures)).toBeInTheDocument();
    fireEvent.drop(comment, dragged(png()));
    await settled();
    expect(screen.queryByRole('img', { name: 'screen.png' })).not.toBeInTheDocument();
  });

  it('is not taken from a field outside the window, but is from a button there', async () => {
    open();
    await line();
    const search = document.body.appendChild(document.createElement('input'));
    expect(fireEvent.paste(search, copied([png()]))).toBe(true);
    search.remove();
    await settled();
    expect(screen.queryByRole('img', { name: 'screen.png' })).not.toBeInTheDocument();
    const button = document.body.appendChild(document.createElement('button'));
    expect(fireEvent.paste(button, copied([png()]))).toBe(false);
    button.remove();
    expect(await preview()).toBeInTheDocument();
  });

  it('is not taken by a window that is minimized', async () => {
    const user = userEvent.setup();
    open();
    await line();
    await user.click(screen.getByRole('button', { name: en.window.minimize }));
    expect(fireEvent.paste(document.body, copied([png()]))).toBe(true);
  });
});

describe('a picture from the button', () => {
  it('is added through the picker, which offers only what can go', async () => {
    const user = userEvent.setup();
    open();
    await line();
    const picker = screen.getByLabelText(en.window.addPicture);
    expect(picker).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp');
    await user.upload(picker, png());
    expect(await preview()).toBeInTheDocument();
    /* The same file again must count as a change. */
    expect(picker).toHaveValue('');
  });
});

describe('what the window turns away', () => {
  const refusedAlert = (text: string) => screen.findByRole('alert').then(a => expect(a).toHaveTextContent(text));

  it('refuses an SVG and a file of no picture type, says why and sends nothing', async () => {
    open();
    await line();
    fireEvent.drop(windowBox(), dragged(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })));
    await refusedAlert(en.errors.picture_invalid);
    expect(screen.queryByRole('img', { name: 'logo.svg' })).not.toBeInTheDocument();
    fireEvent.drop(windowBox(), dragged(new File(['words'], 'notes.txt', { type: 'text/plain' })));
    await refusedAlert(en.errors.picture_invalid);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('says why to the owner of the terminal too, who has no line', async () => {
    open({}, TERMINAL);
    await screen.findByTestId('live-terminal');
    fireEvent.drop(windowBox(), dragged(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })));
    await refusedAlert(en.errors.picture_invalid);
    expect(screen.queryByRole('textbox', { name: LINE })).not.toBeInTheDocument();
  });

  it('stops saying why once the picture is taken back or another comes', async () => {
    const user = userEvent.setup();
    open();
    await line();
    fireEvent.drop(windowBox(), dragged(png()));
    await preview();
    fireEvent.drop(windowBox(), dragged(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })));
    await refusedAlert(en.errors.picture_invalid);
    await user.click(await remove());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.drop(windowBox(), dragged(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })));
    await refusedAlert(en.errors.picture_invalid);
    fireEvent.drop(windowBox(), dragged(png()));
    await preview();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('refuses a renamed file as soon as it turns out to be no picture', async () => {
    open();
    await line();
    fireEvent.drop(windowBox(), dragged(png('notes.png')));
    fireEvent.error(await preview('notes.png'));
    await refusedAlert(en.errors.picture_invalid);
    expect(screen.queryByRole('img', { name: 'notes.png' })).not.toBeInTheDocument();
  });

  it('refuses a picture too big that it cannot make smaller', async () => {
    open();
    await line();
    vi.stubGlobal('createImageBitmap', undefined);
    fireEvent.drop(windowBox(), dragged(png('big.png', 3 * 1024 * 1024 + 1)));
    await refusedAlert(en.errors.picture_too_big);
    fireEvent.drop(windowBox(), dragged(png('exact.png', 3 * 1024 * 1024)));
    expect(await preview('exact.png')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('takes ten pictures to a message and says so of the eleventh', async () => {
    open();
    await line();
    fireEvent.drop(windowBox(), dragged(...Array.from({ length: 11 }, (_, i) => png(`${i}.png`))));
    await refusedAlert(en.errors.pictures_too_many);
    expect(await preview('9.png')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: '10.png' })).not.toBeInTheDocument();
  });

  it("shows the server's refusal and keeps the words and the pictures, without uploading twice", async () => {
    const user = userEvent.setup();
    let refuse = true;
    const { messages, uploads } = open({
      [`POST ${AGENT}/pictures?name=a.png`]: uploaded('a', 'a.png'),
      [`POST ${AGENT}/pictures?name=b.png`]: () => (refuse ? [400, { error: { code: 'validation', message: 'Send a PNG.', reason: 'picture_invalid' } }] : uploaded('b', 'b.png')),
    });
    await line();
    fireEvent.drop(windowBox(), dragged(png('a.png'), png('b.png')));
    await preview('b.png');
    await user.type(await line(), 'Both{Enter}');
    await refusedAlert(en.errors.picture_invalid);
    expect(messages()).toEqual([]);
    expect(await line()).toHaveValue('Both');
    expect(await preview('a.png')).toBeInTheDocument();
    refuse = false;
    await user.type(await line(), '{Enter}');
    await waitFor(() => expect(messages()).toEqual([{ text: 'Both', pictures: ['a', 'b'] }]));
    expect(uploads().filter(path => path.includes('a.png'))).toHaveLength(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a refused message and keeps its pictures for the next try', async () => {
    const user = userEvent.setup();
    let refuse = true;
    const { messages, uploads } = open({
      [`POST ${AGENT}/pictures?name=screen.png`]: uploaded('pic1'),
      [`POST ${AGENT}/messages`]: () => (refuse ? [403, { error: { code: 'forbidden', message: 'No.', reason: 'not_your_department' } }] : [202, { jobId: 'j2' }]),
    });
    await line();
    fireEvent.drop(windowBox(), dragged(png()));
    await user.type(await line(), 'Look{Enter}');
    await refusedAlert(en.errors.not_your_department);
    /* Right above the line, however long the log above it is. */
    expect((await line()).closest('form')!.previousElementSibling).toBe(screen.getByRole('alert'));
    expect(await preview()).toBeInTheDocument();
    refuse = false;
    await user.type(await line(), '{Enter}');
    await waitFor(() => expect(messages()).toHaveLength(2));
    expect(messages()[1]).toEqual({ text: 'Look', pictures: ['pic1'] });
    expect(uploads()).toHaveLength(1);
  });

  it('leaves the failure of a message without pictures where it was, under the log', async () => {
    const user = userEvent.setup();
    open({ [`POST ${AGENT}/messages`]: [403, { error: { code: 'forbidden', message: 'No.', reason: 'not_your_department' } }] });
    await user.type(await line(), 'Words{Enter}');
    await refusedAlert(en.errors.not_your_department);
    expect(screen.getByRole('alert').closest('.t-log')).not.toBeNull();
  });

  it('does not send the same picture twice while it is on its way', async () => {
    const user = userEvent.setup();
    let arrive = () => {};
    const { messages, uploads } = open({ [`POST ${AGENT}/pictures?name=screen.png`]: () => new Promise(done => { arrive = () => done(uploaded('pic1')); }) });
    await line();
    fireEvent.drop(windowBox(), dragged(png()));
    await preview();
    const send = screen.getByRole('button', { name: en.window.sendPictures });
    await user.click(send);
    await user.click(send);
    await user.type(await line(), '{Enter}');
    expect(uploads()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Remove screen.png' })).toBeDisabled();
    arrive();
    await waitFor(() => expect(messages()).toHaveLength(1));
  });

  it('takes nothing while the agent cannot answer, and keeps the page where it is', async () => {
    open({}, { ...READY, ready: false, reason: 'no_subscription' });
    await screen.findByRole('textbox', { name: LINE });
    fireEvent.dragEnter(windowBox(), dragged());
    expect(screen.queryByText(en.window.dropPictures)).not.toBeInTheDocument();
    const over = dragged();
    expect(fireEvent.dragOver(windowBox(), over)).toBe(false);
    expect(over.dataTransfer.dropEffect).toBe('none');
    expect(fireEvent.drop(windowBox(), dragged(png()))).toBe(false);
    expect(fireEvent.paste(await line(), copied([png()]))).toBe(true);
    await settled();
    expect(screen.queryByRole('img', { name: 'screen.png' })).not.toBeInTheDocument();
    expect(screen.getByLabelText(en.window.addPicture)).toBeDisabled();
  });

  it('keeps a picture that misses the window from replacing the page', async () => {
    open();
    await line();
    expect(fireEvent.dragOver(document.body, dragged())).toBe(false);
    expect(fireEvent.drop(document.body, dragged(png()))).toBe(false);
    expect(screen.queryByRole('img', { name: 'screen.png' })).not.toBeInTheDocument();
    expect(fireEvent.drop(document.body, { dataTransfer: { types: ['text/plain'], files: [] } })).toBe(true);
  });

  it('takes nothing at all from someone the server does not let in', async () => {
    const refused = [403, { error: { code: 'forbidden', message: 'No.', reason: 'not_your_department' } }] as [number, unknown];
    const { uploads } = open({ [`GET ${AGENT}/events?after=0`]: refused, [`GET ${AGENT}`]: refused, [`POST ${AGENT}/start`]: refused });
    await screen.findByRole('alert');
    fireEvent.dragEnter(windowBox(), dragged());
    expect(screen.queryByText(en.window.dropPictures)).not.toBeInTheDocument();
    expect(fireEvent.paste(document.body, copied([png()]))).toBe(true);
    expect(uploads()).toEqual([]);
  });
});

describe('a picture in the conversation', () => {
  const person = { id: 'p1', name: 'Ivan' };
  const said: EventView = {
    seq: 1, kind: 'message', jobId: 'j1', person, at: '2026-11-04T10:00:00Z',
    data: { text: 'Look at this', pictures: [{ id: 'pic1', name: 'screen.png' }, { id: 'pic2', name: 'second.png' }] },
    message: { direction: 'in', from: { kind: 'person', id: 'p1', name: 'Ivan', role: null, department: null }, to: { kind: 'agent', id: 'a1', name: 'Orchestrator', agentKind: 'orchestrator', role: null, department: null } },
  };

  it('stands by the message, folded or not, and opens large', async () => {
    open({}, READY, [said]);
    const link = await screen.findByRole('link', { name: 'Open screen.png' });
    expect(link).toHaveAttribute('href', '/api/attachments/pic1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(within(link).getByRole('img', { name: 'screen.png' })).toHaveAttribute('src', '/api/attachments/pic1');
    expect(screen.getByRole('link', { name: 'Open second.png' })).toBeInTheDocument();
  });

  it('stands by a message from before messages named who wrote them', async () => {
    open({}, READY, [{ ...said, message: undefined }]);
    expect(await screen.findByRole('link', { name: 'Open screen.png' })).toBeInTheDocument();
    expect(screen.getByText(/Look at this/)).toBeInTheDocument();
  });

  it('says so once Hornhoof no longer keeps it', async () => {
    open({}, READY, [said]);
    fireEvent.error(within(await screen.findByRole('link', { name: 'Open screen.png' })).getByRole('img'));
    expect(await screen.findByText(en.window.pictureGone('screen.png'))).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open screen.png' })).not.toBeInTheDocument();
  });

  it('shows nothing extra for a message without pictures', async () => {
    open({}, READY, [{ ...said, data: { text: 'Look at this' } }]);
    await screen.findByRole('button', { name: /Message from/ });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(document.querySelector('.t-pics')).toBeNull();
  });
});

describe('the words about pictures', () => {
  it('exist in both languages', () => {
    for (const t of [en, ru]) {
      for (const text of [t.window.dropPictures, t.window.addPicture, t.window.sendPictures, t.window.removePicture('a.png'), t.window.openPicture('a.png'), t.window.pictureGone('a.png'), t.errors.picture_invalid, t.errors.picture_too_big, t.errors.pictures_too_many, t.errors.attachment_invalid, t.errors.attachment_unknown]) {
        expect(text).toBeTruthy();
        expect(text).not.toMatch(/[—ё]/);
      }
    }
    expect(ru.window.dropPictures).not.toBe(en.window.dropPictures);
    expect(ru.errors.picture_too_big).not.toBe(en.errors.picture_too_big);
  });
});
