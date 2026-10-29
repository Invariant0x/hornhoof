import type { Me } from '../types';

export function Shell({ me }: { me: Me; onSignOut: () => void }) {
  return (
    <main>
      <h1>{me.company.name}</h1>
    </main>
  );
}
