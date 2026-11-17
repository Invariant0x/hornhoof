import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { agents, people } from '../src/db/schema.js';
import { RECOVERY_FILE, type Question } from '../src/modules/keeper/question.js';
import { writeKeeperState, type Mode } from '../src/modules/keeper/state.js';
import { as, invitePerson, SETUP, setUpCompany, testApp, until } from './helpers.js';

const [A, B, C] = ['a', 'b', 'c'].map(letter => letter.repeat(64)) as [string, string, string];
const QUESTION: Question = {
  since: '2026-11-12T14:02:30.000Z',
  leader: { networkId: A, host: 'deb', heard: '2026-11-12T14:02:00.000Z' },
  copies: [
    { networkId: B, host: 'mac', number: 2, reach: '2026-11-12T14:01:40.000Z', self: true },
    { networkId: C, host: 'nuc', number: 3, reach: null, self: false },
  ],
  waiting: null,
};

/* A company whose app runs behind a keeper the test speaks for: it leads while the company is set up, and reads from
   then on, with the question the test gives in its keeper's word. */
async function asking(question: Question | null = QUESTION) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-control-'));
  const made = await testApp({ HORNHOOF_KEEPER: 'on', HORNHOOF_CONTROL_DIR: dir });
  const modeNow = async () => (await made.app.inject({ url: '/api/health' })).json().mode;
  const say = async (mode: Mode, asked: Question | null = question) => {
    writeKeeperState(dir, { mode, at: new Date().toISOString(), link: null, ...(asked ? { question: asked } : {}) });
    await until(async () => (await modeNow()) === mode);
  };
  await say('lead', null);
  const ceo = await setUpCompany(made.app);
  const pat = await invitePerson(made.app, ceo, { name: 'Pat', email: 'pat@acme.test', access: { whole: true } });
  const [owner] = await made.db.select().from(people).where(eq(people.isOwner, true));
  const [orchestrator] = await made.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  await say('read');
  const forOwner = { headers: orchestratorHeaders(owner!.id, orchestrator!.id) };
  const refusal = (res: LightMyRequestResponse) => [res.statusCode, (res.json() as { error: { reason?: string } }).error.reason];
  const word = () => (existsSync(join(dir, RECOVERY_FILE)) ? (JSON.parse(readFileSync(join(dir, RECOVERY_FILE), 'utf8')) as Record<string, unknown>) : null);
  const post = (path: string, payload: object, who: object) => made.app.inject({ method: 'POST', url: `/api/network/question/${path}`, payload, ...who });
  return { ...made, dir, say, ceo, pat, owner: owner!, forOwner, refusal, word, post };
}

describe("the question of which copy to go on from, on the copy's app", () => {
  it('shows the question', async () => {
    const s = await asking();
    const seen = async (who: object) => (await s.app.inject({ url: '/api/network/question', ...who })).json();
    expect(await seen(as(s.ceo))).toEqual({ question: QUESTION, canAnswer: true });
    expect(await seen(as(s.pat))).toEqual({ question: QUESTION, canAnswer: false });
    expect(await seen(s.forOwner)).toEqual({ question: QUESTION, canAnswer: true });
    expect((await s.app.inject({ url: '/api/network/question' })).statusCode).toBe(401);
    /* The owner who signed in on this machine while it only reads answers too. */
    const signed = await s.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: SETUP.email, password: SETUP.password } });
    const read = signed.cookies.find(cookie => cookie.name === 'hh_read')!.value;
    expect(await seen({ cookies: { hh_read: read } })).toEqual({ question: QUESTION, canAnswer: true });
    /* No question, or a machine that leads: none. */
    await s.say('read', null);
    await until(async () => (await seen(as(s.ceo))).question === null);
    await s.say('lead', QUESTION);
    expect(await seen(as(s.ceo))).toEqual({ question: null, canAnswer: true });
  });

  it("takes the CEO's answer", async () => {
    const s = await asking();
    const goOn = await s.post('go-on', { networkId: B, reach: '2026-11-12T14:01:40.000Z' }, as(s.ceo));
    expect(goOn.statusCode).toBe(202);
    expect(s.word()).toMatchObject({ goOn: B, reach: '2026-11-12T14:01:40.000Z', by: s.owner.id });
    expect(s.word()!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(s.word()!.at as string))).toBe(false);
    rmSync(join(s.dir, RECOVERY_FILE));
    /* A copy that never said how far it reaches is chosen as it is. */
    expect((await s.post('go-on', { networkId: C, reach: null }, as(s.ceo))).statusCode).toBe(202);
    expect(s.word()).toMatchObject({ goOn: C, reach: null });
    rmSync(join(s.dir, RECOVERY_FILE));
    /* Another reach, or a machine the question does not list: the question the CEO saw is gone. */
    for (const body of [{ networkId: B, reach: '2026-11-12T13:00:00.000Z' }, { networkId: A, reach: null }, { networkId: C, reach: '2026-11-12T14:01:40.000Z' }]) {
      const refused = await s.post('go-on', body, as(s.ceo));
      expect(s.refusal(refused)).toEqual([409, 'question_changed']);
      expect((refused.json() as { error: { message: string } }).error.message).toBe('The question changed. Look again.');
    }
    expect(s.word()).toBeNull();
    /* The CEO alone, by himself or through the orchestrator. */
    expect(s.refusal(await s.post('go-on', { networkId: B, reach: '2026-11-12T14:01:40.000Z' }, as(s.pat)))).toEqual([403, 'not_owner_session']);
    expect(s.refusal(await s.post('wait', {}, as(s.pat)))).toEqual([403, 'not_owner_session']);
    expect(s.word()).toBeNull();
    const wait = await s.post('wait', {}, as(s.ceo));
    expect(wait.statusCode).toBe(202);
    expect(s.word()).toMatchObject({ wait: true, by: s.owner.id });
    expect(s.word()).not.toHaveProperty('goOn');
    rmSync(join(s.dir, RECOVERY_FILE));
    expect((await s.post('wait', {}, s.forOwner)).statusCode).toBe(202);
    expect(s.word()).toMatchObject({ wait: true, by: s.owner.id });
  });

  it('answers that the question changed when none stands', async () => {
    const s = await asking(null);
    expect(s.refusal(await s.post('wait', {}, as(s.ceo)))).toEqual([409, 'question_changed']);
    expect(s.refusal(await s.post('go-on', { networkId: B, reach: null }, as(s.ceo)))).toEqual([409, 'question_changed']);
    expect(s.word()).toBeNull();
  });
});
