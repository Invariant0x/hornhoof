import { useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import type { Messages } from '../i18n/en';
import { Field } from './Field';
import type { SetupChannel } from './OutboundSetup';

type ImportReason = keyof Messages['outboundSetup']['contact']['importReasons'];
type Report = { added: number; updated: number; skipped: { row: number; reason: ImportReason }[] };
const MAX_FILE = 2 * 1024 * 1024;

/* Reads only the selected file; its bytes go to the guarded server route and never to a log or a result view. */
function encoded(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('File read failed.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}

export function ContactImport({ channel, onChanged, onCancel }: { channel: SetupChannel; onChanged(): void; onCancel(): void }) {
  const t = useT();
  const c = t.outboundSetup.contact;
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState('');
  const [evidence, setEvidence] = useState('');
  const [problems, setProblems] = useState<Record<string, string | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const refs = { file: useRef<HTMLInputElement>(null), source: useRef<HTMLInputElement>(null), evidence: useRef<HTMLTextAreaElement>(null) };
  async function save(event: FormEvent) {
    event.preventDefault();
    setFailed(false);
    setReport(null);
    const found = { file: !file || file.size > MAX_FILE || !/\.(csv|xlsx)$/i.test(file.name) ? c.fileInvalid : undefined, source: source.trim() ? undefined : c.sourceMissing, evidence: evidence.trim() ? undefined : c.evidenceMissing };
    setProblems(found);
    const first = (['file', 'source', 'evidence'] as const).find(key => found[key]);
    if (first) { refs[first].current?.focus(); return; }
    setBusy(true);
    try {
      const result = await api.post<Report>('/api/outbound/contacts/import', { channelId: channel.id, filename: file!.name, data: await encoded(file!), source: source.trim(), evidence: evidence.trim() });
      setReport(result);
      onChanged();
    } catch { setFailed(true); }
    finally { setBusy(false); }
  }
  return (
    <form className="repo-form" aria-label={c.importAddresses} noValidate onSubmit={event => void save(event)}>
      <p className="muted" dir="auto">{c.importHint}</p>
      <Field label={c.file} problem={problems.file}>{p => <input {...p} ref={refs.file} type="file" accept=".csv,.xlsx" onChange={event => setFile(event.target.files?.[0] ?? null)} />}</Field>
      <Field label={c.source} hint={c.sourceHint} problem={problems.source}>{p => <input {...p} ref={refs.source} value={source} onChange={event => setSource(event.target.value)} maxLength={200} />}</Field>
      <Field label={c.evidence} hint={c.evidenceHint} problem={problems.evidence}>{p => <textarea {...p} ref={refs.evidence} value={evidence} onChange={event => setEvidence(event.target.value)} maxLength={2000} rows={3} />}</Field>
      <div className="form-foot entry-actions">
        <button className="btn" type="submit" disabled={busy}>{c.importSubmit}</button>
        <button className="btn ghost" type="button" onClick={onCancel}>{t.common.cancel}</button>
      </div>
      {failed && <p className="alert" role="alert" dir="auto">{c.importFailed}</p>}
      {report && <div dir="auto"><p role="status">{c.importSummary(report.added, report.updated, report.skipped.length)}</p><ul className="entries">{report.skipped.map(row => <li className="entry" key={row.row}>{c.importRow(row.row, c.importReasons[row.reason])}</li>)}</ul></div>}
    </form>
  );
}
