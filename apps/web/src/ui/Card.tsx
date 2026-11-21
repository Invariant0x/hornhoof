import type { ReactNode } from 'react';
import { Edge } from './Edge';
import { LogoMark } from './icons';

/* The centered card used by setup, log in and invite screens. `wide` gives it room for the company template grid. */
export function Card({ children, wide = false, topAction }: { children: ReactNode; wide?: boolean; topAction?: ReactNode }) {
  return (
    <main className="stage">
      <Edge className={`card${wide ? ' wide' : ''}`} cut={14}>
        <div className="brand">
          <LogoMark />
          <span>Hornhoof</span>
          {topAction && <span className="card-top-action">{topAction}</span>}
        </div>
        {children}
      </Edge>
    </main>
  );
}
