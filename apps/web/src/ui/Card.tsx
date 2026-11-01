import type { ReactNode } from 'react';
import { Edge } from './Edge';
import { LogoMark } from './icons';

/* The centered card used by setup, log in and invite screens. `wide` gives it room for the company template grid. */
export function Card({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <main className="stage">
      <Edge className={`card${wide ? ' wide' : ''}`} cut={14}>
        <div className="brand">
          <LogoMark />
          Hornhoof
        </div>
        {children}
      </Edge>
    </main>
  );
}
