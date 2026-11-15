/* How much of something is used: a thin bar that turns amber from 70% and pink from 90%. */
export const fullness = (used: number) => (used >= 0.9 ? ' max' : used >= 0.7 ? ' hi' : '');

export const percent = (used: number) => Math.round(used * 100);

/* A share in percent among the big figures, set apart so it takes the text font: the display font's percent sign reads poorly. */
export const Share = ({ of }: { of: number }) => <span className="pct">{of}%</span>;

export function Bar({ used, className, title }: { used: number; className?: string; title?: string }) {
  return (
    <span className={`bar${fullness(used)}${className ? ` ${className}` : ''}`} title={title}>
      <i style={{ width: `${percent(used)}%` }} />
    </span>
  );
}
