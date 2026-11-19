import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useLanguage, useT } from '../i18n';
import type { MergeConflict, MergeDecision, MergePicked } from '../types';

const when = (language: string, iso: string): string => new Date(iso).toLocaleString(language === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/* One row that differs: what it is, its columns with the value here and the value there, and the two ways to settle it. */
function Conflict({ conflict, busy, onPick }: { conflict: MergeConflict; busy: boolean; onPick: (take: 'here' | 'there') => void }) {
  const t = useT();
  const columns = Object.keys(conflict.here ?? conflict.there ?? {});
  return (
    <div role="group" aria-label={conflict.what}>
      <p><b>{conflict.what}</b></p>
      <table className="dt merge-table">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">{t.merge.here}</th>
            <th scope="col">{t.merge.there}</th>
          </tr>
        </thead>
        <tbody>
          {columns.map(column => (
            <tr key={column}>
              <th scope="row">{column}</th>
              <td>{conflict.here ? conflict.here[column] : t.merge.nothing}</td>
              <td>{conflict.there ? conflict.there[column] : t.merge.nothing}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="f">
        <button className="btn small ghost" type="button" disabled={busy} onClick={() => onPick('here')}>{t.merge.keepHere}</button>
        <button className="btn small ghost" type="button" disabled={busy} onClick={() => onPick('there')}>{t.merge.takeThere}</button>
      </div>
    </div>
  );
}

/* What a merge left for the CEO alone: the rows about people, access, plans, machines and protected records that differ
   between this company and a database that came back, table by table, each with both values. He keeps what is here or
   takes what is there, one at a time or a whole table at once. */
/* waitsFor: whom the card waits for, on a list of what waits for more people than one. */
export function MergeCard({ merge, onChange, onFailure, waitsFor }: { merge: MergeDecision; onChange: () => void; onFailure: (err: unknown) => void; waitsFor?: string }) {
  const t = useT();
  const { language } = useLanguage();
  const [conflicts, setConflicts] = useState<MergeConflict[] | null>(null);
  const [busy, setBusy] = useState(false);
  /* What the last pick could not take, in the server's own words. */
  const [left, setLeft] = useState<MergePicked['refused']>([]);
  const title = merge.after ? t.merge.after(when(language, merge.after)) : merge.label;

  const load = useCallback(async () => {
    setConflicts((await api.get<{ conflicts: MergeConflict[] }>(`/api/merges/${merge.id}/conflicts`)).conflicts);
  }, [merge.id]);

  useEffect(() => {
    load().catch(onFailure);
  }, [load, onFailure]);

  async function pick(body: object) {
    setBusy(true);
    try {
      setLeft((await api.post<MergePicked>('/api/merges/pick', body)).refused);
      await load();
      onChange();
    } catch (err) {
      onFailure(err);
    } finally {
      setBusy(false);
    }
  }

  const tables = [...new Set((conflicts ?? []).map(conflict => conflict.table))];
  return (
    <section className="t-card" aria-label={title}>
      <h4>{title}</h4>
      {waitsFor && <p className="muted">{waitsFor}</p>}
      <p className="t-card-brief">{t.merge.needsYou(conflicts?.length ?? merge.open)}</p>
      {left.length > 0 && (
        /* The server writes why in English; another language says that it happened. */
        <p className="muted" role="status">{[t.merge.notTaken(left.length), ...(language === 'en' ? [...new Set(left.map(refused => refused.why))] : [])].join(' ')}</p>
      )}
      {tables.map(table => {
        const rows = conflicts!.filter(conflict => conflict.table === table);
        const topic = t.merge.topics[rows[0]!.topic] ?? rows[0]!.topic;
        return (
          <div key={table} role="group" aria-label={table === rows[0]!.topic ? topic : `${topic}: ${table}`}>
            <p className="muted">{table === rows[0]!.topic ? topic : `${topic}: ${table}`}</p>
            {rows.map(conflict => (
              <Conflict key={conflict.id} conflict={conflict} busy={busy} onPick={take => void pick({ ids: [conflict.id], take })} />
            ))}
            <div className="f">
              <button className="btn small" type="button" disabled={busy} onClick={() => void pick({ merge: merge.id, table, take: 'here' })}>{t.merge.keepAll}</button>
              <button className="btn small" type="button" disabled={busy} onClick={() => void pick({ merge: merge.id, table, take: 'there' })}>{t.merge.takeAll}</button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
