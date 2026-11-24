import { Fragment, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { partyDepartment, useLanguage, useT, type Language, type Messages } from '../i18n';
import { useStream } from '../live';
import { useOpenWindowTask } from '../screens/AgentWindowContext';
import type { InboxLetter, InboxMode, InboxView, MessageParty } from '../types';
import { PanelFrame } from './SidePanels';
import { sayIf } from '@hornhoof/protocol';

type Choice = InboxMode | 'rule';
const CHOICES: Choice[] = ['rule', 'inbox', 'direct'];
/* A person sees the newest letters first, this many, and as many more each time they ask. */
const LETTER_PAGE = 50;
/* The most one read brings; more come a page after the last one shown. */
const READ_AT_ONCE = 200;

const inboxPath = (agentId: string) => `/api/agents/${agentId}/inbox`;

/* How many letters are unread, for the counter on the window's bar: as the employee's card says, again, read with one letter
   only, each time its inbox changes, and as the open inbox last heard it. liveId: the employee's own id, which the live
   messages name, also for the orchestrator's window. */
export function useInboxCount(agentId: string, liveId: string | undefined, fromCard: number | undefined): [number, (n: number) => void] {
  const [count, setCount] = useState<{ n: number; asked: number } | null>(null);
  const asked = useRef(0);
  useEffect(() => setCount(null), [agentId, fromCard]);
  useStream(m => {
    if (fromCard === undefined || m.type !== 'inbox' || m.agentId !== liveId) return;
    const n = ++asked.current;
    api.get<InboxView>(`${inboxPath(agentId)}?limit=1`).then(
      b => setCount(was => (was && was.asked > n ? was : { n: b.unreadCount, asked: n })),
      () => {},
    );
  });
  const heard = useCallback((n: number) => setCount({ n, asked: ++asked.current }), []);
  return [count?.n ?? fromCard ?? 0, heard];
}

/* The newest letters, as many as the person asked to see, read again whenever the inbox changes. What was shown stays while
   it is read again. Answers can come back out of order; one older than the one shown is dropped. */
function useLetters(agentId: string, liveId: string | undefined) {
  const path = inboxPath(agentId);
  const [wanted, setWanted] = useState(LETTER_PAGE);
  const [view, setView] = useState<InboxView | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(null);
  const [reading, setReading] = useState(false);
  const asked = useRef(0);

  const read = useCallback(
    async (count: number) => {
      const n = ++asked.current;
      setReading(true);
      try {
        const first = await api.get<InboxView>(`${path}?limit=${Math.min(count, READ_AT_ONCE)}`);
        let { letters, more } = first;
        while (more && letters.length < count) {
          const next = await api.get<InboxView>(`${path}?limit=${Math.min(count - letters.length, READ_AT_ONCE)}&before=${letters.at(-1)!.id}`);
          letters = [...letters, ...next.letters];
          more = next.more;
        }
        if (n !== asked.current) return;
        setView({ ...first, letters, more });
        setFailure(null);
      } catch (err) {
        if (n === asked.current) setFailure(err);
      } finally {
        if (n === asked.current) setReading(false);
      }
    },
    [path],
  );

  useEffect(() => {
    setView(undefined);
    setFailure(null);
    setWanted(LETTER_PAGE);
    void read(LETTER_PAGE);
  }, [read]);
  useStream(m => {
    if (m.type === 'reconnected' || (m.type === 'inbox' && m.agentId === liveId)) void read(wanted);
  });

  /* What a person's mark did, as its answer says, until the inbox is read again; a read asked before it is dropped. */
  const marked = (ids: string[] | 'all', unreadCount: number) => {
    asked.current++;
    setReading(false);
    setView(v => v && { ...v, unreadCount, letters: v.letters.map(l => (ids === 'all' || ids.includes(l.id) ? { ...l, unread: false } : l)) });
  };
  const more = () => {
    setWanted(wanted + LETTER_PAGE);
    void read(wanted + LETTER_PAGE);
  };
  return { view, failure, reading, again: () => void read(wanted), more, marked };
}

/* When a letter came, in the person's words: the time alone today, yesterday and the time, else the day and the time. */
export function letterTime(language: Language, iso: string, now: number): { shown: string; full: string } {
  const at = new Date(iso);
  const time = new Intl.DateTimeFormat(language, { hour: 'numeric', minute: '2-digit' }).format(at);
  const full = new Intl.DateTimeFormat(language, { dateStyle: 'long', timeStyle: 'short' }).format(at);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const ago = Math.round((day(new Date(now)) - day(at)) / 86_400_000);
  if (ago === 0) return { shown: time, full };
  if (ago === 1) return { shown: `${new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(-1, 'day')}, ${time}`, full };
  return { shown: new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(at), full };
}

/* Who sent a letter: a name, and in muted words what they are. */
function senderOf(t: Messages, language: Language, p: MessageParty): { name: string; about: string | null } {
  if (p.kind === 'hornhoof') return { name: t.window.hornhoof, about: t.agentInbox.system };
  if (p.agentKind === 'orchestrator') return { name: t.window.orchestrator, about: t.window.hornhoof };
  if (p.kind === 'agent' && p.id === null) return { name: t.window.hiddenEmployee, about: null };
  const role = sayIf(p.role, language);
  const named = role && role.toLocaleLowerCase(language) !== p.name.toLocaleLowerCase(language) ? role : null;
  const about = [named, partyDepartment(t, language, p.department)].filter(Boolean).join(' · ');
  return { name: p.name, about: about || null };
}

/* A word with a hyphen, as in a double surname, keeps whole while the line can hold it. */
function keepWhole(text: string): ReactNode {
  return text.split(' ').map((word, i) => (
    <Fragment key={i}>
      {i > 0 && ' '}
      {word.includes('-') ? <span className="nb">{word}</span> : word}
    </Fragment>
  ));
}

/* How letters come to the employee: by its department's rule (the company's for one with none), through the inbox or each at
   once. Whoever may change its rules picks one, saved as it is picked; anyone else reads it. */
function DeliveryMode({ agentId, view, hasDepartment, onSaved }: { agentId: string; view: InboxView; hasDepartment: boolean; onSaved(): void }) {
  const t = useT();
  const uid = useId();
  /* The way just picked shows picked while it is saved, and until the inbox read again says how letters come now. */
  const [picked, setPicked] = useState<Choice | null>(null);
  const [saving, setSaving] = useState(false);
  const saved = useRef(false);
  const [failed, setFailed] = useState(false);
  /* Whether the person moves through the choices by keys: WebKit shows no keyboard focus on a radio an arrow key reached. */
  const [keys, setKeys] = useState(false);
  useEffect(() => {
    if (!saved.current) return;
    saved.current = false;
    setPicked(null);
  }, [view]);
  const shown: Choice = picked ?? view.mode ?? 'rule';
  const effective = shown === 'rule' ? view.inheritedMode : shown;
  const words = { ...t.agentInbox.modes, rule: hasDepartment ? t.agentInbox.modes.rule : t.agentInbox.modes.companyRule };
  const now = t.agentInbox.now(t.agentInbox.nowMode[effective], shown === 'rule' ? t.agentInbox.byRule[hasDepartment ? 'department' : 'company'] : null);

  async function pick(choice: Choice) {
    if (saving) return;
    setPicked(choice);
    setSaving(true);
    setFailed(false);
    saved.current = false;
    try {
      await api.put(`${inboxPath(agentId)}-mode`, { mode: choice === 'rule' ? null : choice });
      saved.current = true;
      onSaved();
    } catch {
      setFailed(true);
      setPicked(null);
    } finally {
      setSaving(false);
    }
  }

  const state = (
    <>
      <p className="inbox-now">{now}</p>
      <p className="inbox-what">{t.agentInbox.modeWhat[effective]}</p>
    </>
  );
  if (!view.canChangeMode) {
    return (
      <section className="inbox-mode" aria-labelledby={`${uid}-label`}>
        <p className="inbox-mode-label" id={`${uid}-label`}>{t.agentInbox.modeLabel}</p>
        {state}
        <p className="inbox-what">{t.agentInbox.readOnly}</p>
      </section>
    );
  }
  return (
    <fieldset className="inbox-mode" aria-busy={saving} data-keys={keys || undefined} onKeyDown={() => setKeys(true)} onPointerDown={() => setKeys(false)}>
      <legend className="inbox-mode-label">{t.agentInbox.modeLabel}</legend>
      <div className="inbox-choices">
        {CHOICES.map(choice => (
          <label key={choice} className={shown === choice ? 'on' : undefined}>
            <input type="radio" name={uid} value={choice} checked={shown === choice} onChange={() => void pick(choice)} />
            <span className="inbox-dot" aria-hidden="true" />
            <span>{words[choice]}</span>
          </label>
        ))}
      </div>
      <div aria-live="polite">{state}</div>
      {saving && <p className="inbox-what" role="status">{t.agentInbox.saving}</p>}
      {failed && <p className="inbox-mark-err" role="alert">{t.agentInbox.modeFailed}</p>}
    </fieldset>
  );
}

/* One letter: who sent it, what it is, when it came and whether it is read, its task and its first two lines; the rest opens
   in place. Opening it marks nothing; only the person's button does. */
function Letter({ letter, canMark, failed, onMark }: { letter: InboxLetter; canMark: boolean; failed: boolean; onMark(): void }) {
  const t = useT();
  const { language } = useLanguage();
  const openTask = useOpenWindowTask();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const { name, about } = senderOf(t, language, letter.sender);
  const when = letterTime(language, letter.receivedAt, Date.now());
  const lines = letter.text.split('\n');
  const long = lines.length > 2;
  const task = letter.task;
  const taskWords = task && (
    <>
      <b>#{task.number}</b>
      {task.title && <> {task.title}</>}
    </>
  );
  return (
    <li className={`entry${letter.unread ? ' unread' : ''}`} aria-labelledby={`${uid}-from`} aria-describedby={`${uid}-state`}>
      <div className="entry-main">
        <p className="inbox-from" id={`${uid}-from`}>
          <b>{keepWhole(name)}</b>
          {about && <span>{keepWhole(about)}</span>}
        </p>
        <p className="inbox-meta">
          <span className="inbox-kind">{t.agentInbox.kinds[letter.kind]}</span>
          <time dateTime={letter.receivedAt} title={when.full}>{when.shown}</time>
          <span className={`inbox-state ${letter.unread ? 'new' : 'old'}`} id={`${uid}-state`}>
            <i aria-hidden="true" />
            {letter.unread ? t.agentInbox.unread : t.agentInbox.read}
          </span>
        </p>
        {task && (task.id && openTask ? (
          <button className="t-link" type="button" onClick={e => openTask(task.id!, e.currentTarget)}>{taskWords}</button>
        ) : (
          <p className="inbox-task">{taskWords}</p>
        ))}
        <p className="inbox-text" id={`${uid}-text`}>{long && !open ? lines.slice(0, 2).join('\n') : letter.text}</p>
        {long && !open && <p className="inbox-fold">{t.agentInbox.more(lines.length - 2)}</p>}
      </div>
      {failed && <p className="inbox-mark-err" role="alert">{t.agentInbox.markFailed}</p>}
      {(long || (letter.unread && canMark)) && (
        <div className="entry-actions">
          {long && (
            <button className="btn ghost" type="button" aria-expanded={open} aria-controls={`${uid}-text`} aria-label={open ? t.agentInbox.foldOf(name) : t.agentInbox.openOf(name)} onClick={() => setOpen(!open)}>
              {open ? t.agentInbox.fold : t.agentInbox.open}
            </button>
          )}
          {letter.unread && canMark && (
            <button className="btn ghost" type="button" aria-label={t.agentInbox.markOneOf(name)} onClick={onMark}>
              {t.agentInbox.markOne}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function ListHead({ children }: { children?: ReactNode }) {
  const t = useT();
  return (
    <div className="inbox-sum">
      <h4>{t.agentInbox.title}</h4>
      {children}
    </div>
  );
}

/* The employee's inbox, a panel of its window: how its letters come, then every letter, newest first, with the unread ones
   marked. The CEO, the CEO delegate and whoever runs its department change how they come and mark them read. onUnread hears
   how many are unread, each time the panel learns it. */
export function Inbox({ agentId, liveId, hasDepartment, onClose, onUnread }: { agentId: string; liveId: string | undefined; hasDepartment: boolean; onClose(): void; onUnread?(n: number): void }) {
  const t = useT();
  const { view, failure, reading, again, more, marked } = useLetters(agentId, liveId);
  const heading = useRef<HTMLHeadingElement>(null);
  const [failed, setFailed] = useState<string | 'all' | null>(null);
  const unread = view?.unreadCount;
  useEffect(() => {
    if (unread !== undefined) onUnread?.(unread);
  }, [unread, onUnread]);

  async function mark(which: string[] | 'all') {
    setFailed(null);
    try {
      const { unreadCount } = await api.post<{ unreadCount: number }>(`${inboxPath(agentId)}/read`, which === 'all' ? { all: true } : { ids: which });
      marked(which, unreadCount);
      heading.current?.focus();
    } catch {
      setFailed(which === 'all' ? 'all' : which[0]!);
    }
  }

  const loading = view === undefined && failure === null;
  let list: ReactNode;
  if (loading) {
    list = (
      <>
        <ListHead />
        <p className="inbox-status" role="status">
          <span className="spinner" aria-hidden="true" />
          {t.agentInbox.loading}
        </p>
        <div className="inbox-skel" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      </>
    );
  } else if (view === undefined) {
    list = (
      <>
        <ListHead />
        <Unread onRetry={again} />
      </>
    );
  } else if (!view.letters.length) {
    list = (
      <>
        <ListHead />
        <div className="inbox-empty">
          <b>{t.agentInbox.emptyHead}</b>
          <p>{t.agentInbox.emptyText}</p>
        </div>
      </>
    );
  } else {
    list = (
      <>
        <div className="inbox-sum">
          <div className="inbox-sum-text">
            <h4 ref={heading} tabIndex={-1}>{t.agentInbox.title}</h4>
            <p role="status">{view.unreadCount ? t.agentInbox.sumUnread(view.unreadCount, view.total) : t.agentInbox.sumAll(view.total)}</p>
          </div>
          {view.canMarkRead && view.unreadCount > 0 && (
            <div className="entry-actions">
              <button className="btn ghost" type="button" onClick={() => void mark('all')}>{t.agentInbox.markAll}</button>
            </div>
          )}
        </div>
        {failed === 'all' && <p className="inbox-mark-err" role="alert">{t.agentInbox.markAllFailed}</p>}
        <ul className="entries" aria-label={t.agentInbox.title}>
          {view.letters.map(letter => (
            <Letter key={letter.id} letter={letter} canMark={view.canMarkRead} failed={failed === letter.id && letter.unread} onMark={() => void mark([letter.id])} />
          ))}
        </ul>
        {failure !== null && <Unread onRetry={again} />}
        {view.more && failure === null && (
          <div className="entry-actions">
            <button className="btn ghost" type="button" disabled={reading} onClick={more}>{t.agentInbox.showMore}</button>
          </div>
        )}
      </>
    );
  }
  return (
    <PanelFrame label={t.agentInbox.panel} busy={loading} kind="inbox" onClose={onClose}>
      {view && <DeliveryMode agentId={agentId} view={view} hasDepartment={hasDepartment} onSaved={again} />}
      {list}
    </PanelFrame>
  );
}

function Unread({ onRetry }: { onRetry(): void }) {
  const t = useT();
  return (
    <div className="alert inbox-alert" role="alert">
      <p>
        <b>{t.agentInbox.errorHead}</b> {t.agentInbox.errorText}
      </p>
      <div className="entry-actions">
        <button className="btn" type="button" onClick={onRetry}>{t.agentInbox.retry}</button>
      </div>
    </div>
  );
}
