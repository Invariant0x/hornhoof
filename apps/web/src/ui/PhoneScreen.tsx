import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import type { PhoneView } from './Phones';

export type PhoneFrameView = { sequence: number; at: string; masked: boolean; imageUrl: string | null };

export function PhoneFrame({ frame, name }: { frame: PhoneFrameView; name: string }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [frame.imageUrl]);
  return <figure className="phone-screen">
    {frame.imageUrl && !failed ? <img src={frame.imageUrl} alt={t.phones.screenFor(name)} onError={() => setFailed(true)} /> : <p>{failed ? t.phones.screenError : t.phones.shielded}</p>}
    <figcaption><time dateTime={frame.at}>{t.phones.updated(new Date(frame.at).toLocaleString())}</time>{frame.masked && <p>{t.phones.shielded}</p>}</figcaption>
  </figure>;
}

export function PhoneScreen({ phone }: { phone: PhoneView }) {
  const t = useT();
  const [frame, setFrame] = useState<PhoneFrameView | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!phone.lending) return;
    let disposed = false;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const reply = await api.get<{ frame: PhoneFrameView | null; lending: boolean }>(`/api/phones/${phone.id}/live`);
        if (!disposed) { setFrame(reply.lending ? reply.frame : null); setFailed(false); }
      } catch { if (!disposed) setFailed(true); }
      finally { pending = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 1500);
    return () => { disposed = true; clearInterval(timer); };
  }, [phone.id, phone.lending, attempt]);
  return <section aria-label={t.phones.live}>
    {!phone.lending ? <p>{t.phones.paused}</p> : failed ? <div role="alert"><p>{t.phones.screenError}</p><button className="btn" type="button" onClick={() => setAttempt(n => n + 1)}>{t.phones.retry}</button></div> : frame ? <PhoneFrame frame={frame} name={phone.name} /> : <p role="status">{t.phones.waitingFrame}</p>}
  </section>;
}
