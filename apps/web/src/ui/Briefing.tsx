import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import type { Briefing, BriefingRepository } from '../types';
import { Field } from './Field';

type Draft = { url: string; branch: string; rules: string; authorName: string; authorEmail: string };

const toDraft = (r: BriefingRepository): Draft => ({ url: r.url, branch: r.branch, rules: r.rules, authorName: r.author?.name ?? '', authorEmail: r.author?.email ?? '' });
const fromDraft = (d: Draft): BriefingRepository => ({
  url: d.url.trim(),
  branch: d.branch.trim() || 'main',
  rules: d.rules,
  author: d.authorName.trim() ? { name: d.authorName.trim(), email: d.authorEmail.trim() } : null,
});
const BLANK: Draft = { url: '', branch: 'main', rules: '', authorName: '', authorEmail: '' };

/* What a department or one of its products keeps for its agents, for the people who may change it there: how they work
   and their repositories, the cloned one first. */
export function BriefingPanel({ placeId }: { placeId: string }) {
  const t = useT();
  const path = `/api/departments/${placeId}/briefing`;
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [draft, setDraft] = useState<{ text: string; repositories: Draft[] } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let on = true;
    api.get<{ briefing: Briefing }>(path).then(r => on && setBriefing(r.briefing), err => on && setFailure(err));
    return () => { on = false; };
  }, [path]);

  function save(e: FormEvent) {
    e.preventDefault();
    if (draft) void keep(draft);
  }

  async function keep(draft: { text: string; repositories: Draft[] }) {
    setBusy(true);
    setFailure(null);
    try {
      const saved = await api.put<{ briefing: Briefing }>(path, { text: draft.text, repositories: draft.repositories.map(fromDraft) });
      setBriefing(saved.briefing);
      setDraft(null);
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  const alert = failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>;
  if (!briefing) return failure !== null ? alert : <p className="muted">{t.common.loading}</p>;

  if (draft) {
    const change = (i: number, part: Partial<Draft>) => setDraft({ ...draft, repositories: draft.repositories.map((r, j) => (j === i ? { ...r, ...part } : r)) });
    const halfAuthor = draft.repositories.some(r => !r.authorName.trim() !== !r.authorEmail.trim());
    return (
      <form className="briefing-form" onSubmit={save}>
        <Field label={t.briefing.text}>{p => <textarea {...p} value={draft.text} rows={5} maxLength={20_000} onChange={e => setDraft({ ...draft, text: e.target.value })} />}</Field>
        {draft.repositories.map((r, i) => (
          <fieldset key={i} className="briefing-repo">
            <legend>{t.briefing.repository(i + 1)}</legend>
            <Field label={t.dept.address}>{p => <input {...p} value={r.url} onChange={e => change(i, { url: e.target.value })} maxLength={500} placeholder="https://github.com/acme/shop.git" required />}</Field>
            <Field label={t.dept.branch}>{p => <input {...p} value={r.branch} onChange={e => change(i, { branch: e.target.value })} maxLength={200} />}</Field>
            <Field label={t.briefing.rules}>{p => <textarea {...p} value={r.rules} rows={3} maxLength={4000} onChange={e => change(i, { rules: e.target.value })} />}</Field>
            <Field label={t.dept.authorName}>{p => <input {...p} value={r.authorName} onChange={e => change(i, { authorName: e.target.value })} maxLength={200} placeholder={t.dept.authorPlaceholder} />}</Field>
            <Field label={t.dept.authorEmail}>{p => <input {...p} type="email" value={r.authorEmail} onChange={e => change(i, { authorEmail: e.target.value })} maxLength={320} />}</Field>
            <button className="btn small ghost" type="button" onClick={() => setDraft({ ...draft, repositories: draft.repositories.filter((_, j) => j !== i) })}>{t.briefing.remove}</button>
          </fieldset>
        ))}
        <div className="repo-actions">
          {draft.repositories.length < 20 && <button className="btn small ghost" type="button" onClick={() => setDraft({ ...draft, repositories: [...draft.repositories, BLANK] })}>{t.briefing.add}</button>}
          <button className="btn small" type="submit" disabled={busy || halfAuthor}>{t.common.save}</button>
          <button className="btn small ghost" type="button" onClick={() => setDraft(null)}>{t.common.cancel}</button>
        </div>
        {alert}
      </form>
    );
  }

  const { connected } = briefing;
  const listed = briefing.repositories.filter(r => r.url !== connected?.url);
  const ownRules = connected && briefing.repositories.find(r => r.url === connected.url)?.rules;
  const by = briefing.by && (briefing.by.byOrchestrator ? t.briefing.byOrchestrator : briefing.by.name ? t.briefing.by(briefing.by.name) : null);
  return (
    <div className="briefing">
      {briefing.text ? <p className="briefing-text">{briefing.text}</p> : <p className="muted">{t.briefing.empty}</p>}
      {(connected || listed.length > 0) && (
        <ul className="dv-list" aria-label={t.briefing.repositories}>
          {connected && (
            <li>
              <span className="repo-url">{connected.url}</span>
              <small>{t.briefing.cloned(connected.branch)}</small>
              {connected.author && <small>{t.dept.commitsAs(connected.author.name, connected.author.email)}</small>}
              {ownRules && <small className="briefing-text">{ownRules}</small>}
            </li>
          )}
          {listed.map(r => (
            <li key={r.url}>
              <span className="repo-url">{r.url}</span>
              <small>{t.dept.branchIs(r.branch)}</small>
              {r.author && <small>{t.dept.commitsAs(r.author.name, r.author.email)}</small>}
              {r.rules && <small className="briefing-text">{r.rules}</small>}
            </li>
          ))}
        </ul>
      )}
      {by && <small className="muted">{by}</small>}
      <div className="repo-actions">
        <button className="btn small ghost" type="button" onClick={() => setDraft({ text: briefing.text, repositories: briefing.repositories.map(toDraft) })}>{t.dept.change}</button>
      </div>
      {alert}
    </div>
  );
}
