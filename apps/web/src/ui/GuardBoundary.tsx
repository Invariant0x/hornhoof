import type { ReactNode } from 'react';
/* Not yet built: a block shows as it is. */
export function GuardBoundary({ children }: { block: string; children: ReactNode }) {
  return <>{children}</>;
}
export function LightNotice() {
  return null;
}
