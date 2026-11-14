import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT, type Language, type Messages } from '../i18n';
import { useStream } from '../live';
import { useLive } from '../tasks';
import type { InboxLetter, InboxMode, InboxView } from '../types';
import { partyName } from './AgentMessage';

type Choice = InboxMode | 'rule';
const CHOICES: Choice[] = ['rule', 'inbox', 'direct'];

export const inboxPath = (agentId: string) => `/api/agents/${agentId}/inbox`;

/* The employee's inbox as the server keeps it, read again when it changes. liveId: the employee's own id, which the live
   messages name, also for the orchestrator's window. */
export function useInbox(agentId: string, liveId: string | undefined, on = true) {
  return useLive(on ? inboxPath(agentId) : null, (b: InboxView) => b, m => m.type === 'inbox' && m.agentId === liveId);
}

/* How many letters are unread, for the counter on the window's bar: as the employee's card says, and again, read with one
   letter only, each time its inbox changes. */
export function useInboxCount(agentId: string, liveId: string | undefined, fromCard: number | undefined): number {
  const [count, setCount] = useState<{ n: number; asked: number } | null>(null);
  const asked = useRef(0);
  useEffect(() => setCount(null), [agentId, fromCard]);
  useStream(m => {
    if (fromCard === undefined || m.type !== 'inbox' || m.agentId !== liveId) return;
    const n = ++asked.current;
    api.get<InboxView>(`${inboxPath(agentId)}?limit=1`).then(
      b => setCount(was => (was && was.asked > n ? was : { n: b.unread, asked: n })),
      () => {},
    );
  });
  return count?.n ?? fromCard ?? 0;
}

const when = (language: Language, iso: string) => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

function modeWords(t: Messages, hasDepartment: boolean): Record<Choice, string> {
  const m = t.inbox.mode;
  return { rule: hasDepartment ? m.byDepartment : m.byCompany, inbox: m.inbox, direct: m.direct };
}

/* How letters come to the employee: by its department's rule (the company's for one with none), through the inbox or each at
   once. Whoever may change its rules picks one, saved as it is picked; anyone else reads it in words. */
function DeliveryMode({ agentId, view, hasDepartment, onSaved }: { agentId: string; view: InboxView; hasDepartment: boolean; onSaved(): void }) {
  const t = useT();
  const uid = useId();
  /* The way just picked shows picked while it is saved, and until the inbox read again says how letters come now. */
  const [picked, setPicked] = useState<Choice | null>(null);
  const saved = useRef(false);
  const [failure, setFailure] = useState<unknown>(null);
  const words = modeWords(t, hasDepartment);
  useEffect(() => {
    if (!saved.current) return;
    saved.current = false;
    setPicked(null);
  }, [view]);
  const hints: Record<Choice, string> = { rule: t.inbox.mode.byRuleHint(words[view.mode.inherited]), inbox: t.inbox.mode.inboxHint, direct: t.inbox.mode.directHint };
  const stored: Choice = view.mode.own ?? 'rule';

  async function pick(choice: Choice) {
    setPicked(choice);
    setFailure(null);
    saved.current = false;
    try {
      await api.put(`${inboxPath(agentId)}-mode`, { mode: choice === 'rule' ? null : choice });
      saved.current = true;
      onSaved();
    } catch (err) {
      setFailure(err);
      setPicked(null);
    }
  }

  if (!view.canChange) return <p>{t.inbox.mode.is(words[view.mode.effective])}</p>;
  const shown = picked ?? stored;
  return (
    <>
      <fieldset className="choice">
        <legend className="inbox-legend">{t.inbox.mode.title}</legend>
        {CHOICES.map(choice => (
          <label key={choice} className={shown === choice ? 'on' : ''}>
            <input type="radio" name={uid} value={choice} checked={shown === choice} disabled={picked !== null} onChange={() => void pick(choice)} aria-labelledby={`${uid}-${choice}`} aria-describedby={`${uid}-${choice}-hint`} />
            <b id={`${uid}-${choice}`}>{words[choice]}</b>
            <span id={`${uid}-${choice}-hint`}>{hints[choice]}</span>
          </label>
        ))}
      </fieldset>
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
    </>
  );
}

/* One letter: what it is and who sent it, its department, task and time, and its whole text. Reading it here marks
   nothing; only the person's button does. */
function Letter({ letter, canMark, busy, onMark }: { letter: InboxLetter; canMark: boolean; busy: boolean; onMark(): void }) {
  const t = useT();
  const { language } = useLanguage();
  const who = partyName(t, language, letter.sender);
  const source = letter.kind === 'notification' && letter.source ? t.notificationSources[letter.source as keyof Messages['notificationSources']] : undefined;
  const meta = [letter.sender.department?.name[language], source, letter.task && t.inbox.onTask(letter.task.number, letter.task.title), when(language, letter.at)].filter(Boolean).join(' · ');
  const unread = letter.status === 'unread';
  return (
    <li className={`entry${unread ? ' unread' : ''}`}>
      <div className="entry-main">
        <b>{t.inbox.letter(t.inbox.kinds[letter.kind], who)}</b>
        <small className="entry-meta">{meta}</small>
        {unread && <span className="badge inbox-unread">{t.inbox.unread}</span>}
        <p className="inbox-text">{letter.text}</p>
      </div>
      {unread && canMark && (
        <div className="entry-actions" role="group" aria-label={t.inbox.letter(t.inbox.kinds[letter.kind], who)}>
          <button className="act" type="button" aria-label={t.inbox.markReadOf(who)} disabled={busy} onClick={onMark}>
            {t.inbox.markRead}
          </button>
        </div>
      )}
    </li>
  );
}

/* The employee's inbox in its window: every letter, newest last, with the unread ones marked, and under them how its letters
   come.
   The CEO, the CEO delegate and the owner of its department mark letters read and change how they come. */
export function Inbox({ agentId, liveId, hasDepartment }: { agentId: string; liveId: string | undefined; hasDepartment: boolean }) {
  const t = useT();
  const { data, failure, load } = useInbox(agentId, liveId);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<unknown>(null);

  async function mark(body: { ids: string[] } | { all: true }) {
    setBusy(true);
    setRefused(null);
    try {
      await api.post(`${inboxPath(agentId)}/read`, body);
      load();
    } catch (err) {
      setRefused(err);
    } finally {
      setBusy(false);
    }
  }

  const loading = data === undefined && !failure;
  return (
    <section className="inbox" aria-label={t.inbox.title} aria-busy={busy || loading}>
      <p className="muted">{t.inbox.intro}</p>
      {loading && <p className="muted">{t.inbox.loading}</p>}
      {failure ? (
        <div className="notebook-unread">
          <p className="error" role="alert">{t.inbox.unreadLoad} {errorText(t, failure)}</p>
          <button className="btn small ghost" type="button" onClick={load}>{t.app.tryAgain}</button>
        </div>
      ) : null}
      {data && data.letters.length > 0 && <p className="muted">{t.inbox.openingKeeps}</p>}
      {data && data.unread > 0 && (
        <div className="form-foot inbox-foot">
          <span className="inbox-count" role="status">{t.inbox.unreadCount(data.unread)}</span>
          {data.canChange && <button className="btn" type="button" disabled={busy} onClick={() => void mark({ all: true })}>{t.inbox.markAllRead}</button>}
        </div>
      )}
      {busy && <p className="muted" role="status">{t.inbox.marking}</p>}
      {refused !== null && <p className="error" role="alert">{errorText(t, refused)}</p>}
      {data && !data.letters.length && <p className="muted">{t.inbox.empty}</p>}
      {data && data.letters.length > 0 && (
        <ul className="entries" aria-label={t.inbox.title}>
          {data.letters.map(letter => <Letter key={letter.id} letter={letter} canMark={data.canChange} busy={busy} onMark={() => void mark({ ids: [letter.id] })} />)}
        </ul>
      )}
      {data && <DeliveryMode agentId={agentId} view={data} hasDepartment={hasDepartment} onSaved={load} />}
    </section>
  );
}
