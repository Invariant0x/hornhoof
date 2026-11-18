import { PrivateValues, type ToolPrivacy } from '@hornhoof/protocol';
import { describe, expect, it, vi } from 'vitest';
import { SessionPrivacy } from '../src/terminal/privacy.js';

const SESSION = 'a-agent';
const reply = (text: string) => ({ result: { content: [{ type: 'image' }, { text }] } });

function session() {
  const values = new PrivateValues();
  const tmux = { outputValues: vi.fn((name: string) => { expect(name).toBe(SESSION); return values; }), maskRecording: vi.fn(async () => {}) };
  const log = vi.fn();
  return { values, tmux, log, privacy: new SessionPrivacy(tmux, log) };
}

describe('the privacy of an agent\'s session', () => {
  it('keeps what a sensitive tool gives back with the turn, as JSON or plain text, and masks the recording', async () => {
    const s = session();
    const turn: { privacy?: ToolPrivacy } = {};
    await s.privacy.tool(SESSION, turn, 'vault_entry', { entry: 'Partner' }, reply(JSON.stringify({ password: 'pw-Secret-42' })));
    /* A tool marked sensitive with no output fields keeps its whole reply, here plain text. */
    await s.privacy.tool(SESSION, turn, 'custom_secret', {}, reply('plain-Secret-9'), { sensitive: true });
    expect(turn.privacy?.sensitive).toBe(true);
    expect(turn.privacy?.values.text('pw-Secret-42 and plain-Secret-9')).not.toMatch(/pw-Secret-42|plain-Secret-9/);
    expect(s.tmux.maskRecording.mock.calls).toEqual([[SESSION], [SESSION]]);
  });

  it('keeps the values on the session\'s screens when no turn runs, and leaves no turn behind', async () => {
    const s = session();
    await s.privacy.tool(SESSION, null, 'vault_entry', { entry: 'Partner' }, reply(JSON.stringify({ password: 'pw-Outside-7' })));
    expect(s.values.text('the pw-Outside-7 here')).not.toContain('pw-Outside-7');
    expect(s.tmux.maskRecording).toHaveBeenCalledWith(SESSION);
  });

  it('takes nothing from a reply that is no object', async () => {
    const s = session();
    const turn: { privacy?: ToolPrivacy } = {};
    await s.privacy.tool(SESSION, turn, 'vault_entry', { entry: 'Partner' }, 'pw-Loose-3');
    expect(turn.privacy?.values.text('pw-Loose-3')).toBe('pw-Loose-3');
    /* No reply at all, or one that failed without a result, still counts the call and masks the recording. */
    await s.privacy.tool(SESSION, turn, 'vault_entry', { entry: 'Partner' }, null);
    await s.privacy.tool(SESSION, turn, 'vault_entry', { entry: 'Partner' }, { error: { message: 'pw-Loose-3' } });
    expect(turn.privacy?.sensitive).toBe(true);
    expect(s.tmux.maskRecording).toHaveBeenCalledTimes(3);
  });

  it('masks a known value in what the program says, and tells the recording only of a new value', async () => {
    const s = session();
    const turn: { privacy?: ToolPrivacy } = {};
    await s.privacy.tool(SESSION, turn, 'vault_entry', { entry: 'Partner' }, reply(JSON.stringify({ password: 'pw-Secret-42' })));
    s.tmux.maskRecording.mockClear();
    const said = s.privacy.event(SESSION, turn, { kind: 'text', text: 'I used pw-Secret-42' }, () => undefined);
    expect(said).toMatchObject({ kind: 'text' });
    expect(JSON.stringify(said)).not.toContain('pw-Secret-42');
    expect(s.tmux.maskRecording).not.toHaveBeenCalled();
  });

  it('starts a turn\'s privacy from what the session\'s screens already mask', async () => {
    const s = session();
    await s.privacy.tool(SESSION, null, 'vault_entry', { entry: 'Partner' }, reply(JSON.stringify({ password: 'pw-Before-5' })));
    const fresh = s.privacy.fresh(SESSION);
    expect(fresh.values.text('pw-Before-5')).not.toContain('pw-Before-5');
    const turn: { privacy?: ToolPrivacy } = {};
    expect(s.privacy.event(SESSION, turn, { kind: 'text', text: 'pw-Before-5' }, () => undefined)).not.toMatchObject({ text: 'pw-Before-5' });
    expect(turn.privacy?.values).toBe(s.values);
  });
});
