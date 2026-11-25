import { Fragment } from 'react';
import { useLanguage, useT } from '../i18n';
import type { DatabaseSize } from '../types';
import { gigabytes } from './MachineDisk';

/* The company's database past its line, in words for the CEO: how big it is, what takes the most of it and what to do.
   Nothing here waits for an answer: the card goes by itself once the database is under its line again. */
export function DatabaseLarge({ size }: { size: DatabaseSize | null }) {
  const t = useT();
  const { language } = useLanguage();
  if (!size) return null;
  const gb = (bytes: number) => gigabytes(language, bytes);
  const title = t.tasks.databaseLarge(gb(size.line));
  const tables = size.tables.map((table, i) => <Fragment key={table.name}>{i > 0 && ', '}<bdi>{table.name}</bdi> {t.machines.database.tableSize(gb(table.bytes))}</Fragment>);
  const [before, after] = t.tasks.databaseLargeTables('\u{F0001}').split('\u{F0001}');
  return (
    <section className="machine-away" aria-label={title}>
      <h3>{title}</h3>
      <p>{t.tasks.databaseLargeNow(gb(size.bytes))}</p>
      {size.tables.length > 0 && <p>{before}{tables}{after}</p>}
      <p>{t.tasks.databaseLargeDo}</p>
    </section>
  );
}
