import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import type { BackupsView, Me } from '../types';

/* Under the top bar, for the CEO alone: while the company has no recovery file that opens its backups, a line that says
   so and opens the company's settings, where the file is saved. again: anything that changes when the settings were
   closed, so the banner looks once more. */
export function RecoveryBanner({ me, again, onOpen }: { me: Me; again?: unknown; onOpen: () => void }) {
  const t = useT();
  const [view, setView] = useState<Pick<BackupsView, 'recoveryNeeded' | 'linkChanged'> | null>(null);
  const owner = me.person.isOwner;

  useEffect(() => {
    if (!owner) return;
    let current = true;
    /* A server from before backups, or one that is busy, says nothing: then there is nothing to ask for. */
    api.get<Pick<BackupsView, 'recoveryNeeded' | 'linkChanged'>>('/api/backups/recovery').then(said => current && setView(said), () => current && setView(null));
    return () => {
      current = false;
    };
  }, [owner, again]);

  if (!owner || !view?.recoveryNeeded) return null;
  return (
    <div className="update-banner glass" role="status" aria-label={t.backups.title}>
      <span dir="auto">{view.linkChanged ? t.backups.bannerLink : t.backups.banner}</span>
      <button className="btn small" type="button" onClick={onOpen}>{t.backups.openSettings}</button>
    </div>
  );
}
