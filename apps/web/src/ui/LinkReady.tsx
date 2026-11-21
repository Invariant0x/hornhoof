import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import type { TlsView } from '../types';
import { CopyButton } from './CopyButton';
import { LetsEncryptNote } from './LetsEncryptNote';

export type MadeLink = { name: string; url: string };

/* The certificate is asked about this often, and shown without it after this long. */
const POLL_MS = 2000;
const GIVE_UP_MS = 90_000;

type Stage = 'wait' | 'ready' | 'later';

/* Waits for the new link's own certificate: ready once the server holds it, later when it takes more than 90 seconds. */
function useCertificateStage(): Stage {
  const [stage, setStage] = useState<Stage>('wait');
  useEffect(() => {
    if (stage !== 'wait') return;
    let live = true;
    const ask = () =>
      api
        .get<{ tls: TlsView | null }>('/api/link')
        .then(found => live && found.tls?.certificate && setStage('ready'))
        .catch(() => undefined);
    void ask();
    const poll = setInterval(() => void ask(), POLL_MS);
    const giveUp = setTimeout(() => setStage('later'), GIVE_UP_MS);
    return () => {
      live = false;
      clearInterval(poll);
      clearTimeout(giveUp);
    };
  }, [stage]);
  return stage;
}

/* What setup shows after it made a public link: that the certificate is on its way, then the link to copy. */
export function LinkReady({ link, onNext }: { link: MadeLink; onNext: () => void }) {
  const t = useT();
  const stage = useCertificateStage();
  return (
    <>
      <p className="muted">{stage === 'wait' ? t.setup.linkWait : stage === 'ready' ? t.setup.linkReady : t.setup.linkLater}</p>
      {stage !== 'wait' && (
        <div className="settings-link">
          <a href={link.url} target="_blank" rel="noreferrer">{link.url}</a>
          <CopyButton text={link.url} />
        </div>
      )}
      <LetsEncryptNote />
      <div className="actions">
        <button className="btn" type="button" data-guide-anchor="Setup.linkNext" onClick={onNext}>{t.common.next}</button>
      </div>
    </>
  );
}
