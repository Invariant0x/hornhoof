import { ContactFieldName, ContactFieldValue } from '@hornhoof/protocol';
import type { RefObject } from 'react';
import type { Messages } from '../i18n/en';
import { Field } from './Field';

export type ContactValueRow = { name: string; value: string };
export type ContactValueProblems = Record<string, string | undefined>;
type Words = Messages['outboundSetup']['contact'];

export function contactValueProblems(rows: ContactValueRow[], words: Words): ContactValueProblems {
  const problems: ContactValueProblems = {};
  const names = new Set<string>();
  rows.forEach((row, i) => {
    if (!row.name && !row.value) return;
    if (!ContactFieldName.safeParse(row.name).success || names.has(row.name)) problems[`fieldName${i}`] = words.fieldNameInvalid;
    if (!ContactFieldValue.safeParse(row.value).success) problems[`fieldValue${i}`] = words.fieldValueInvalid;
    names.add(row.name);
  });
  return problems;
}

export const contactValues = (rows: ContactValueRow[]): Record<string, string> => Object.fromEntries(rows.filter(row => row.name || row.value).map(row => [row.name, row.value]));

export function ContactValues({ rows, onChange, problems, refs, words }: { rows: ContactValueRow[]; onChange(rows: ContactValueRow[]): void; problems: ContactValueProblems; refs: RefObject<Record<string, HTMLInputElement | null>>; words: Words }) {
  const change = (i: number, key: keyof ContactValueRow, value: string) => onChange(rows.map((row, n) => n === i ? { ...row, [key]: value } : row));
  return (
    <div className="repo-form">
      <p className="muted" dir="auto">{words.fieldsHint}</p>
      {rows.map((row, i) => (
        <div className="repo-form" key={i}>
          <Field label={`${words.fieldName} ${i + 1}`} problem={problems[`fieldName${i}`]}>
            {p => <input {...p} ref={el => { refs.current[`fieldName${i}`] = el; }} value={row.name} onChange={e => change(i, 'name', e.target.value)} maxLength={80} dir="ltr" autoComplete="off" spellCheck={false} />}
          </Field>
          <Field label={`${words.fieldValue} ${i + 1}`} problem={problems[`fieldValue${i}`]}>
            {p => <input {...p} ref={el => { refs.current[`fieldValue${i}`] = el; }} value={row.value} onChange={e => change(i, 'value', e.target.value)} dir="auto" autoComplete="off" />}
          </Field>
        </div>
      ))}
      <div className="entry-actions"><button className="btn ghost" type="button" disabled={rows.length >= 50} onClick={() => onChange([...rows, { name: '', value: '' }])}>{words.addField}</button></div>
    </div>
  );
}
