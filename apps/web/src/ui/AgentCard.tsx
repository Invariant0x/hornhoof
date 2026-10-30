import { useEffect, useId, useState } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT } from '../i18n';
import type { AgentCardView, Me, Part, SubView } from '../types';
import { Ask } from './Ask';
import { servingLabel } from './StaffCard';

type Props = { me: Me; agentId: string; onClose(): void; onTerminal(): void };

const SKILL = /<!-- hh:skill ([a-z0-9-]+) -->\n## [^\n]*\n\n([\s\S]*?)\n<!-- \/hh:skill -->/g;

/* What a person edits in a part: the role's text, or a skill's body without its markers and title. */
export function bodyOf(part: Part): string {
  if (part.kind !== 'skill') return part.text;
  const m = /^<!-- hh:skill [a-z0-9-]+ -->\n## [^\n]*\n\n([\s\S]*)\n<!-- \/hh:skill -->$/.exec(part.text);
  return m ? m[1]! : part.text;
}

/* The role's text and each skill's body from an edited raw text, or null when its first part or the skill markers changed. */
export function fromRaw(raw: string, parts: Part[]): { base: string | null; skills: Record<string, string> } | null {
  const header = parts.find(p => p.kind === 'header')?.text ?? '';
  if (!raw.startsWith(header)) return null;
  const blocks = [...raw.matchAll(SKILL)];
  const ids = parts.filter(p => p.kind === 'skill').map(p => p.id);
  if (blocks.length !== ids.length || blocks.some((b, i) => b[1] !== ids[i])) return null;
  for (let i = 0; i < blocks.length; i++) {
    const end = blocks[i]!.index + blocks[i]![0].length;
    if (raw.slice(end, blocks[i + 1]?.index ?? raw.length).trim()) return null;
  }
  const base = raw
    .slice(header.length, blocks[0]?.index ?? raw.length)
    .replace(/^\n\n/, '')
    .replace(/\n\n$/, '');
  return { base: parts.some(p => p.kind === 'base') ? base : null, skills: Object.fromEntries(blocks.map(b => [b[1]!, b[2]!])) };
}

const keyOf = (p: Part) => (p.kind === 'base' ? 'base' : (p.id ?? ''));

const subLabel = (s: SubView) => servingLabel({ kind: s.kind, label: s.label, provider: s.provider, owner: s.owner.name });

/* An agent's card in the side panel: where it runs, its skills and the text it runs with, with every change kept. */
export function AgentCard({ me, agentId, onClose, onTerminal }: Props) {
  const t = useT();
  const { language } = useLanguage();
  const id = useId();
  const [card, setCard] = useState<AgentCardView | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [raw, setRaw] = useState(false);
  /* What the person typed and has not saved: per part in the view by skill, the whole text in the raw view. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [rawDraft, setRawDraft] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const [asking, setAsking] = useState<'reset' | 'remove' | null>(null);
  const company = me.person.scopeKind === 'company';
  const base = `/api/agents/${agentId}`;

  useEffect(() => {
    let live = true;
    api.get<AgentCardView>(base).then(
      c => live && setCard(c),
      err => live && setFailure(err),
    );
    return () => {
      live = false;
    };
  }, [base]);

  async function save(run: () => Promise<AgentCardView>) {
    setFailure(null);
    setSaved(false);
    try {
      setCard(await run());
      setDrafts({});
      setRawDraft(null);
      setBroken(false);
      setSaved(true);
    } catch (err) {
      setFailure(err);
    }
  }
  const change = (body: object) => save(() => api.patch<AgentCardView>(base, body));

  function savePrompt() {
    if (!card) return;
    let next: { base: string | null; skills: Record<string, string> };
    if (rawDraft !== null) {
      const parsed = fromRaw(rawDraft, card.parts);
      if (!parsed) return setBroken(true);
      next = parsed;
    } else {
      const { base: own, ...skills } = drafts;
      next = { base: own ?? null, skills };
    }
    const body: { base?: string; skillText?: Record<string, string> } = {};
    const basePart = card.parts.find(p => p.kind === 'base');
    if (basePart && next.base !== null && next.base !== bodyOf(basePart)) body.base = next.base;
    for (const p of card.parts.filter(x => x.kind === 'skill')) {
      const text = next.skills[p.id ?? ''];
      if (text !== undefined && text !== bodyOf(p)) body.skillText = { ...body.skillText, [p.id!]: text };
    }
    if (body.base === undefined && !body.skillText) {
      setDrafts({});
      setRawDraft(null);
      return;
    }
    void change(body);
  }

  async function remove() {
    setAsking(null);
    try {
      await api.del(base);
      onClose();
    } catch (err) {
      setFailure(err);
    }
  }

  const bar = (title: string) => (
    <div className="t-bar">
      <span className="lights" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{title}</span>
      <button type="button" aria-label={t.window.close} onClick={onClose}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );

  if (!card) {
    return (
      <aside className="acard" aria-busy={failure === null}>
        {bar('')}
        {failure !== null && (
          <p className="alert" role="alert">
            {errorText(t, failure)}
          </p>
        )}
      </aside>
    );
  }

  const orchestrator = card.kind === 'orchestrator';
  const title = orchestrator ? t.window.title : card.name;
  const runs = card.runsOn.find(r => r.subscription.id === card.subscription?.id);
  const subs = card.subscription && !runs ? [{ subscription: card.subscription, models: [] }, ...card.runsOn] : card.runsOn;
  const models = runs?.models ?? [];
  const where = [card.department?.name, card.product?.name].filter(Boolean).join(', ');
  const dirty = rawDraft !== null ? rawDraft !== card.raw : Object.keys(drafts).length > 0;
  const when = (at: string) => new Date(at).toLocaleString(language === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' });

  return (
    <aside className="acard" aria-label={title}>
      {bar(title)}
      <div className="ac-body">
        <header className="ac-head">
          <h3>{title}</h3>
          {card.role && <p>{card.role.title[language]}</p>}
          {where && <p className="muted">{where}</p>}
          <p className="ac-state">
            <i className={`dot ${card.state}`} />
            {t.dept.states[card.state]}
          </p>
          <button className="btn small" type="button" onClick={onTerminal}>
            {t.agent.openTerminal}
          </button>
        </header>
        {!company && <p className="muted">{t.agent.viewOnly}</p>}

        <div className="ac-pick">
          <div className="field">
            <label htmlFor={`${id}-sub`}>{t.agent.runsOn}</label>
            <select id={`${id}-sub`} value={card.subscription?.id ?? ''} disabled={!company} onChange={e => void change({ subscription: e.target.value || null })}>
              {(!orchestrator || !card.subscription) && <option value="">{t.agent.noSubscription}</option>}
              {subs.map(r => (
                <option key={r.subscription.id} value={r.subscription.id}>
                  {subLabel(r.subscription)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-model`}>{t.agent.model}</label>
            <select id={`${id}-model`} value={card.model} disabled={!company || !card.subscription} onChange={e => void change({ model: e.target.value })}>
              <option value="">{t.agent.default}</option>
              {card.model && !models.some(m => m.id === card.model) && <option value={card.model}>{card.model}</option>}
              {models.map(m => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {saved && (
          <p className="ac-note" role="status">
            {t.agent.applies}
          </p>
        )}
        {failure !== null && (
          <p className="alert" role="alert">
            {errorText(t, failure)}
          </p>
        )}

        {!orchestrator && (
          <section className="ac-skills" aria-labelledby={`${id}-skills`}>
            <h4 id={`${id}-skills`}>{t.agent.skills}</h4>
            {card.skills.map(s => (
              <label key={s.id} className={s.locked ? 'lock' : ''}>
                <input type="checkbox" checked={s.on || s.locked} disabled={!company || s.locked} onChange={e => void change({ skills: { [s.id]: e.target.checked } })} />
                <span>
                  <b>{s.title[language]}</b>
                  <small>{s.description[language]}</small>
                </span>
                {s.templateChanged && s.overridden && <em className="t-card-tag">{t.agent.templateChanged}</em>}
              </label>
            ))}
          </section>
        )}

        <section className="ac-prompt" aria-labelledby={`${id}-prompt`}>
          <div className="ac-prompt-top">
            <h4 id={`${id}-prompt`}>{t.agent.prompt}</h4>
            {!orchestrator && (
              <div className="seg">
                <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>
                  {t.agent.bySkill}
                </button>
                <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>
                  {t.agent.raw}
                </button>
              </div>
            )}
          </div>
          {orchestrator && <p className="muted">{t.agent.orchestratorNote}</p>}
          {orchestrator ? (
            <pre className="ac-text">{card.raw}</pre>
          ) : raw ? (
            <>
              <label className="sr" htmlFor={`${id}-raw`}>
                {t.agent.raw}
              </label>
              <textarea id={`${id}-raw`} className="ac-text" rows={18} value={rawDraft ?? card.raw} readOnly={!company} onChange={e => setRawDraft(e.target.value)} />
            </>
          ) : (
            card.parts.map(p =>
              p.kind === 'header' ? (
                <div key="header" className="ac-part">
                  <span>{t.agent.header}</span>
                  <pre className="ac-text">{p.text}</pre>
                </div>
              ) : (
                <div key={keyOf(p)} className="ac-part">
                  <label htmlFor={`${id}-${keyOf(p)}`}>{p.title?.[language] ?? p.id}</label>
                  {p.templateChanged && p.overridden && <em className="t-card-tag">{t.agent.templateChanged}</em>}
                  <textarea
                    id={`${id}-${keyOf(p)}`}
                    className="ac-text"
                    rows={Math.min(14, Math.max(3, bodyOf(p).split('\n').length + 1))}
                    value={drafts[keyOf(p)] ?? bodyOf(p)}
                    readOnly={!company}
                    onChange={e => setDrafts(d => ({ ...d, [keyOf(p)]: e.target.value }))}
                  />
                </div>
              ),
            )
          )}
          {broken && (
            <p className="alert" role="alert">
              {t.agent.rawBroken}
            </p>
          )}
          {company && dirty && (
            <div className="f">
              <button className="btn small" type="button" onClick={savePrompt}>
                {t.common.save}
              </button>
              <button
                className="btn small ghost"
                type="button"
                onClick={() => {
                  setDrafts({});
                  setRawDraft(null);
                  setBroken(false);
                }}
              >
                {t.common.cancel}
              </button>
            </div>
          )}
        </section>

        {company && !orchestrator && (
          <div className="ac-actions">
            {asking === 'reset' ? (
              <Ask text={t.agent.resetAsk(card.name)} yes={t.agent.yesReset} onYes={() => { setAsking(null); void save(() => api.post<AgentCardView>(`${base}/reset`)); }} onNo={() => setAsking(null)} />
            ) : asking === 'remove' ? (
              <Ask text={t.agent.removeAsk(card.name)} yes={t.agent.yesRemove} onYes={() => void remove()} onNo={() => setAsking(null)} />
            ) : (
              <>
                {card.role && (
                  <button className="act" type="button" onClick={() => setAsking('reset')}>
                    {t.agent.reset}
                  </button>
                )}
                <button className="act danger" type="button" onClick={() => setAsking('remove')}>
                  {t.agent.remove}
                </button>
              </>
            )}
          </div>
        )}

        {card.changes.length > 0 && (
          <section className="ac-history" aria-labelledby={`${id}-history`}>
            <h4 id={`${id}-history`}>{t.agent.history}</h4>
            <ul>
              {card.changes.map((c, i) => (
                <li key={i}>{t.agent.changed(t.agent.fields[c.field] ?? c.field, c.personName, when(c.at))}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}
