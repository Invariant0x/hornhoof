import type { CSSProperties, ReactNode } from 'react';

/* name: the frame stands as a group of that name, and title its tooltip. */
type Props = { cut?: number; accent?: boolean; corner?: boolean; className?: string; style?: CSSProperties; name?: string; title?: string; children?: ReactNode };

/* The chamfered frame: one cut corner top right, one bottom left, and on a department the cyan corner top left. */
export function Edge({ cut = 10, accent = false, corner = false, className = '', style, name, title, children }: Props) {
  return (
    <div className={`edge${accent ? ' accent' : ''} ${className}`.trim()} style={{ ['--cut' as string]: `${cut}px`, ...style }} role={name ? 'group' : undefined} aria-label={name} title={title}>
      <div className="edge-in">{children}</div>
      {corner && <span className="corner" aria-hidden="true" />}
    </div>
  );
}
