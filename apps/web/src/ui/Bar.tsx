/* How much of something is used: a thin bar that turns amber from 70% and pink from 90%. */
const fullness = (used: number) => (used >= 0.9 ? ' max' : used >= 0.7 ? ' hi' : '');

export const percent = (used: number) => Math.round(used * 100);

/* The percent signs a language may write: the common one, the Arabic one and the full-width one. */
const SIGN = /([%\u066A\uFF05])/;

/* A share in percent among the big figures, as its language writes it, for the sign and a space stand differently in
   other languages. Its figures keep the font of their line; only the sign is set apart, to take the text font, as the
   display font's percent sign reads poorly. */
export function Share({ children }: { children: string }) {
  return <>{children.split(SIGN).map((part, i) => (i % 2 ? <span key={i} className="pct">{part}</span> : part))}</>;
}

export function Bar({ used, className, title }: { used: number; className?: string; title?: string }) {
  return (
    <span className={`bar${fullness(used)}${className ? ` ${className}` : ''}`} title={title}>
      <i style={{ width: `${percent(used)}%` }} />
    </span>
  );
}
