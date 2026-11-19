import { Fragment, useId, type ReactNode } from 'react';
import { Bar } from './Bar';
import { Edge } from './Edge';

export function Facts({ items, className = 'facts' }: { items: [string, ReactNode][]; className?: string }) {
  return <dl className={className}>{items.map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd>{value}</dd></Fragment>)}</dl>;
}

/* A name with a sign right after its last letter. A line may break before any picture, even after a space that never
   breaks, so only the last letter and the sign stand in a span that never wraps, and the rest of the name wraps as ever. */
export function NameWithSign({ name, sign }: { name: string; sign: ReactNode }) {
  const letters = Array.from(name);
  const last = letters.pop();
  return <>{letters.join('')}<span className="name-end">{last}{sign}</span></>;
}

/* sign: a mark right after the name's last letter; under: a small line under the name. */
export function CardHead({ mark, name, tier, sign, badges, under, state, line }: { mark: ReactNode; name: string; tier?: string | null; sign?: ReactNode; badges?: ReactNode; under?: ReactNode; state: ReactNode; line?: ReactNode }) {
  return <header className="card-h"><div className="card-t">{mark}<h3>{sign ? <NameWithSign name={name} sign={sign} /> : name}{tier && <> <small>{tier}</small></> }</h3>{badges}{under && <small className="card-under">{under}</small>}</div><div className="stline">{state}{line && <span>{line}</span>}</div></header>;
}

export function CardFrame({ label, accent, head, children, extra }: { label: string; accent?: boolean; head: ReactNode; children: ReactNode; extra?: ReactNode }) {
  return <article className="wcard" aria-label={label}><Edge className="machine" cut={12} accent={accent} corner={accent}>{head}<div className="blocks">{children}</div>{extra}</Edge></article>;
}

/* A block of its own at the bottom of a card: a heading that names it for the eye and for a screen reader, then its parts. */
export function CardBlock({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return <section className="blk mc-blk" aria-labelledby={id}><h4 id={id}>{title}</h4>{children}</section>;
}

export function Part({ title, children }: { title: string; children: ReactNode }) {
  return <section className="part"><h5 className="part-h">{title}</h5>{children}</section>;
}

/* name and title: what the tile says in full, where its figure is short. */
export function Gauge({ label, figure, unit, used, sub, empty = false, name, title }: { label: ReactNode; figure: ReactNode; unit?: string; used?: number | null; sub?: ReactNode; empty?: boolean; name?: string; title?: string }) {
  return <Edge className={`gauge${empty ? ' na' : ''}`} cut={8} name={name} title={title}><span className="g-l">{label}</span><p className="g-f"><b>{figure}</b>{unit && <span>{unit}</span>}</p>{used !== undefined && used !== null && <Bar used={used} />}{sub && <span className="g-s">{sub}</span>}</Edge>;
}

export function EmptyBox({ title, hint }: { title: string; hint?: string }) {
  return <div className="empty"><b>{title}</b>{hint && <span dir="auto">{hint}</span>}</div>;
}

export function MachineMark() {
  return <svg className="ic mc" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="8.5" rx="1" /><path d="M5.5 13.5h5M8 11v2.5" /></svg>;
}
