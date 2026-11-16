import type { CSSProperties, ReactNode } from 'react';

/* name: the frame stands as a group of that name, and title its tooltip. halo: the frame is what a button shows, and the
   button's glow and focus ring go around the frame in its own shape. */
type Props = { cut?: number; accent?: boolean; corner?: boolean; halo?: boolean; className?: string; style?: CSSProperties; name?: string; title?: string; children?: ReactNode };

/* The chamfered frame: one cut corner top right, one bottom left, and on a department the cyan corner top left. */
export function Edge({ cut = 10, accent = false, corner = false, halo = false, className = '', style, name, title, children }: Props) {
  const frame = (
    <div className={`edge${accent ? ' accent' : ''} ${className}`.trim()} style={{ ['--cut' as string]: `${cut}px`, ...style }} role={name ? 'group' : undefined} aria-label={name} title={title}>
      <div className="edge-in">{children}</div>
      {corner && <span className="corner" aria-hidden="true" />}
    </div>
  );
  if (!halo) return frame;
  /* The halo stands under the frame, outside its clip-path, with the same cut: the glow is a shadow of a copy of the
     frame's shape and the focus ring a band of that shape, so neither leaves a square corner or a triangle at a cut. */
  return (
    <>
      <span className="halo" style={{ ['--cut' as string]: `${cut}px` }} aria-hidden="true">
        <span className="halo-glow">
          <i />
        </span>
        <span className="halo-ring" />
      </span>
      {frame}
    </>
  );
}
