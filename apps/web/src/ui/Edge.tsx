import type { CSSProperties, ReactNode } from 'react';

type Props = { cut?: number; accent?: boolean; className?: string; style?: CSSProperties; children?: ReactNode };

/* The chamfered frame from the prototype: one cut corner top right, one bottom left. */
export function Edge({ cut = 10, accent = false, className = '', style, children }: Props) {
  return (
    <div className={`edge${accent ? ' accent' : ''} ${className}`.trim()} style={{ ['--cut' as string]: `${cut}px`, ...style }}>
      <div className="edge-in">{children}</div>
    </div>
  );
}
