import type { ReactNode } from 'react';
import { Edge } from './Edge';
import { LogoMark } from './icons';

/* The centered card used by setup, log in and invite screens. */
export function Card({ children }: { children: ReactNode }) {
  return (
    <main className="stage">
      <Edge className="card" cut={14}>
        <div className="brand">
          <LogoMark />
          Hornhoof
        </div>
        {children}
      </Edge>
    </main>
  );
}
