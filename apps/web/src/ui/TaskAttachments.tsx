import { useState } from 'react';
import { api, ApiFailure } from '../api';
import { errorText, useT, type Messages } from '../i18n';
import type { TaskFile } from '../types';

export type FullTextRef = { field: 'text' | 'evidence'; id: string; name: string; size: number };

const AUTO_TEXT_FILE = /^([a-z_]+-(?:text|evidence))-[0-9a-f]{64}(\.txt)$/;
const attachmentPath = (id: string) => `/api/attachments/${encodeURIComponent(id)}`;
const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isFullTextField = (v: unknown): v is 'text' | 'evidence' => v === 'text' || v === 'evidence';

export const displayFileName = (name: string): string => name.replace(AUTO_TEXT_FILE, '$1$2');
export const proseErrorText = (t: Messages, err: unknown): string => (err instanceof ApiFailure && err.reason === 'attachment_invalid' ? t.tasks.textTooLarge : errorText(t, err));
const fileErrorText = (t: Messages, err: unknown): string => (err instanceof ApiFailure && err.reason === 'attachment_unknown' ? t.tasks.fileMissing : errorText(t, err));

function cleanPreview(preview: string, id: string): string {
  const suffix = `\n\n[Full text](${attachmentPath(id)})`;
  return preview.endsWith(suffix) ? `${preview.slice(0, -suffix.length)}…` : preview;
}

export function formatFileSize(t: Messages, bytes: number): string {
  const safe = Math.max(0, bytes);
  if (safe < 1024) return t.tasks.fileBytes(safe);
  if (safe < 1024 * 1024) return t.tasks.fileKb(Math.ceil(safe / 1024));
  return t.tasks.fileMb((safe / (1024 * 1024)).toFixed(1));
}

function parseFullText(item: unknown): FullTextRef | null {
  if (!item || typeof item !== 'object') return null;
  const r = item as Record<string, unknown>;
  if (!isFullTextField(r.field) || !nonEmptyString(r.id) || !nonEmptyString(r.name)) return null;
  return typeof r.size === 'number' && Number.isFinite(r.size) && r.size >= 0
    ? { field: r.field, id: r.id, name: r.name, size: r.size }
    : null;
}

export function fullTextOf(data: unknown, target: 'text' | 'evidence'): FullTextRef | null {
  const list = data && typeof data === 'object' ? (data as Record<string, unknown>).fullTexts : undefined;
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    const parsed = parseFullText(item);
    if (parsed?.field === target) return parsed;
  }
  return null;
}

function useFullText(id: string) {
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  async function toggle() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (loaded !== null) {
      setExpanded(true);
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const full = await api.text(attachmentPath(id));
      setLoaded(full);
      setExpanded(true);
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  return { expanded, loaded, busy, failure, toggle };
}

export function ExpandableLogField({ preview, fullRef, prefix = '', className }: { preview: string; fullRef: FullTextRef; prefix?: string; className?: string }) {
  const t = useT();
  const { expanded, loaded, busy, failure, toggle } = useFullText(fullRef.id);
  const shown = expanded ? (loaded as string) : cleanPreview(preview, fullRef.id);
  const buttonLabel = busy ? t.common.loading : expanded ? t.tasks.showLess : t.tasks.readFull;

  return (
    <>
      <p className={className}>
        {prefix}
        {shown}
      </p>
      <div className="req-actions">
        <button className="btn small ghost" type="button" aria-expanded={expanded} disabled={busy} onClick={() => void toggle()}>
          {buttonLabel}
        </button>
        <a className="req-link" href={attachmentPath(fullRef.id)} target="_blank" rel="noopener noreferrer">
          {t.tasks.openFile(displayFileName(fullRef.name), formatFileSize(t, fullRef.size))}
        </a>
      </div>
      {failure !== null && (
        <p className="alert" role="alert">
          {fileErrorText(t, failure)}
        </p>
      )}
    </>
  );
}

export function LogParagraph({ text, fullRef, prefix = '', className }: { text: string | null; fullRef: FullTextRef | null; prefix?: string; className?: string }) {
  if (!text) return null;
  if (fullRef) return <ExpandableLogField key={fullRef.id} preview={text} fullRef={fullRef} prefix={prefix} className={className} />;
  return (
    <p className={className}>
      {prefix}
      {text}
    </p>
  );
}

export function TaskFiles({ files }: { files?: TaskFile[] }) {
  const t = useT();
  if (!files?.length) return null;
  return (
    <section aria-label={t.tasks.files}>
      <h4>{t.tasks.files}</h4>
      <ul className="tp-subs">
        {files.map(f => {
          const autoText = AUTO_TEXT_FILE.test(f.name);
          const name = displayFileName(f.name);
          return (
            <li key={f.id}>
              <a
                className="req-link"
                href={attachmentPath(f.id)}
                download={autoText ? undefined : name}
                target={autoText ? '_blank' : undefined}
                rel={autoText ? 'noopener noreferrer' : undefined}
              >
                {f.big ? `${name} · ${t.tasks.bigFile}` : name}
              </a>
              <small>{formatFileSize(t, f.size)}</small>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
