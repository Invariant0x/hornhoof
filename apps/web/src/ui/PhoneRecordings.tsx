import { useEffect, useState } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import { PhoneFrame, type PhoneFrameView } from './PhoneScreen';

type Recording = { id: string; phone: string; agent: string; status: 'queued' | 'starting' | 'active' | 'revoking' | 'ended' | 'cancelled'; reason: string | null; startedAt: string | null; endedAt: string | null; frames: PhoneFrameView[] };

export function PhoneRecordings({ taskId }: { taskId: string }) {
  const t = useT();
  const [recordings, setRecordings] = useState<Recording[] | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    setRecordings(null); setFailure(null);
    void api.get<{ recordings: Recording[] }>(`/api/tasks/${taskId}/phone-recordings`).then(reply => { if (!disposed) setRecordings(reply.recordings); }, error => { if (!disposed) setFailure(error); });
    return () => { disposed = true; };
  }, [taskId, attempt]);
  return <section className="phone-recordings" aria-label={t.phones.recordings}>
    <h3>{t.phones.recordings}</h3>
    {failure !== null ? <div role="alert"><p className="bad">{errorText(t, failure)}</p><button className="btn" type="button" onClick={() => setAttempt(n => n + 1)}>{t.phones.retry}</button></div> : recordings === null ? <p role="status">{t.common.loading}</p> : recordings.length === 0 ? <p className="muted">{t.phones.noRecordings}</p> : recordings.map(r => <RecordingEntry key={r.id} recording={r} />)}
  </section>;
}

function RecordingEntry({ recording: r }: { recording: Recording }) {
  const t = useT();
  const [opened, setOpened] = useState(false);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const last = r.frames.length - 1;
  useEffect(() => {
    if (!opened || !playing || index >= last) return;
    const timer = setInterval(() => setIndex(i => Math.min(i + 1, last)), 1500);
    return () => clearInterval(timer);
  }, [opened, playing, index, last]);
  function move(next: number) { setPlaying(false); setIndex(next); }
  return <article className="phone-recording" aria-label={r.phone}>
    <h4>{r.phone}</h4><p>{r.agent}</p><p>{t.phones.recordingStates[r.status]}</p>
    {r.startedAt && <p><time dateTime={r.startedAt}>{new Date(r.startedAt).toLocaleString()}</time></p>}
    <div className="entry-actions"><button type="button" className="act" disabled={r.frames.length === 0} aria-expanded={opened} onClick={() => { setOpened(v => !v); setPlaying(false); }}>{opened ? t.phones.closeReplay : t.phones.replay}</button></div>
    {opened && r.frames[index] && <>
      <PhoneFrame frame={r.frames[index]} name={r.phone} />
      <p role="status">{t.phones.frameOf(index + 1, r.frames.length)}</p>
      <div className="entry-actions">
        <button type="button" className="act" disabled={index === 0} onClick={() => move(index - 1)}>{t.phones.previous}</button>
        <button type="button" className="btn" disabled={last === 0} onClick={() => { if (index >= last) setIndex(0); setPlaying(v => !v || index >= last); }}>{playing && index < last ? t.phones.pause : t.phones.play}</button>
        <button type="button" className="act" disabled={index >= last} onClick={() => move(index + 1)}>{t.phones.next}</button>
      </div>
    </>}
  </article>;
}
