import type { ReactNode } from 'react';

/* The words of a main button, and what it says while its action runs. Both stay in the button and the one not shown is
   hidden, so the button keeps the width of the longer one and the group around it does not move. */
export function BusyLabel({ busy, idle, working }: { busy: boolean; idle: ReactNode; working: ReactNode }) {
  return (
    <span className="busy-swap">
      <span aria-hidden={busy || undefined}>{idle}</span>
      <span aria-hidden={!busy || undefined}>{working}</span>
    </span>
  );
}
