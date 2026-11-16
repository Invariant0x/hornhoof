import { Fragment, type ReactNode } from 'react';
import { Bar } from './Bar';
import { Edge } from './Edge';

export function Facts({ items, className = 'facts' }: { items: [string, ReactNode][]; className?: string }) {
  return <dl className={className}>{items.map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd>{value}</dd></Fragment>)}</dl>;
}

/* sign: a mark by the name's first line that stays there however the name wraps; under: a small line under the name. */
export function CardHead({ mark, name, tier, sign, badges, under, state, line }: { mark: ReactNode; name: string; tier?: string | null; sign?: ReactNode; badges?: ReactNode; under?: ReactNode; state: ReactNode; line?: ReactNode }) {
  const title = <h3>{name}{tier && <> <small>{tier}</small></> }</h3>;
  return <header className="card-h"><div className="card-t">{mark}{sign ? <span className="card-n">{title}{sign}</span> : title}{badges}{under && <small className="card-under">{under}</small>}</div><div className="stline">{state}{line && <span>{line}</span>}</div></header>;
}

export function CardFrame({ label, accent, head, children, extra }: { label: string; accent?: boolean; head: ReactNode; children: ReactNode; extra?: ReactNode }) {
  return <article className="wcard" aria-label={label}><Edge className="machine" cut={12} accent={accent} corner={accent}>{head}<div className="blocks">{children}</div>{extra}</Edge></article>;
}

export function Part({ title, children }: { title: string; children: ReactNode }) {
  return <section className="part"><h5 className="part-h">{title}</h5>{children}</section>;
}

/* name and title: what the tile says in full, where its figure is short. */
export function Gauge({ label, figure, unit, used, sub, empty = false, name, title }: { label: string; figure: ReactNode; unit?: string; used?: number | null; sub?: ReactNode; empty?: boolean; name?: string; title?: string }) {
  return <Edge className={`gauge${empty ? ' na' : ''}`} cut={8} name={name} title={title}><span className="g-l">{label}</span><p className="g-f"><b>{figure}</b>{unit && <span>{unit}</span>}</p>{used !== undefined && used !== null && <Bar used={used} />}{sub && <span className="g-s">{sub}</span>}</Edge>;
}

export function EmptyBox({ title, hint }: { title: string; hint?: string }) {
  return <div className="empty"><b>{title}</b>{hint && <span>{hint}</span>}</div>;
}

export function MachineMark() {
  return <svg className="ic mc" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="8.5" rx="1" /><path d="M5.5 13.5h5M8 11v2.5" /></svg>;
}
