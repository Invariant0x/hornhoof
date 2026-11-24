/* The world's loading screen (#1947 item 1): shown over the map only on the first visit and when the pictures kept in
   the browser are out of date. Three steps, each with what it really measures: the pictures by the bytes downloaded,
   the city and map laid out, the ground pieces baked. No spinner: every row says where it stands. */

import { useLanguage, useT } from '../i18n';

export type WorldLoadStep = 'art' | 'map' | 'bake';

export type WorldLoadProgress = Readonly<{
  step: WorldLoadStep;
  loadedBytes: number;
  totalBytes: number;
  bakedChunks: number;
  totalChunks: number;
}>;

const ORDER: readonly WorldLoadStep[] = ['art', 'map', 'bake'];
const MB = 1024 * 1024;

type Row = Readonly<{ step: WorldLoadStep; label: string; now: number; max: number; text: string; state: 'waiting' | 'now' | 'done' }>;

export function WorldLoadingScreen({ progress }: { progress: WorldLoadProgress }) {
  const t = useT().skins.worldLoad;
  const { language } = useLanguage();
  const mb = new Intl.NumberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const at = ORDER.indexOf(progress.step);
  const rows: Row[] = ORDER.map((step, i) => {
    const state = i < at ? 'done' : i === at ? 'now' : 'waiting';
    const label = t[step];
    if (state !== 'now') return { step, label, now: state === 'done' ? 1 : 0, max: 1, text: t[state], state };
    if (step === 'art') {
      const total = Math.max(1, Math.round(progress.totalBytes));
      const now = Math.min(total, Math.round(progress.loadedBytes));
      return { step, label, now, max: total, text: t.megabytes(mb.format(progress.loadedBytes / MB), mb.format(progress.totalBytes / MB)), state };
    }
    if (step === 'bake' && progress.totalChunks > 0) {
      return { step, label, now: progress.bakedChunks, max: progress.totalChunks, text: t.chunks(progress.bakedChunks, progress.totalChunks), state };
    }
    return { step, label, now: 0, max: 1, text: t.now, state };
  });
  return (
    <div className="world-loading" role="status" aria-live="polite">
      <div className="world-loading-card glass">
        <h2>{t.title}</h2>
        <ol>
          {rows.map(r => (
            <li key={r.step} className={`world-loading-step ${r.state}`}>
              <span className="world-loading-label">{r.label}</span>
              <span className="world-loading-value">{r.text}</span>
              <span
                className="bar"
                role="progressbar"
                aria-label={r.label}
                aria-valuemin={0}
                aria-valuemax={r.max}
                aria-valuenow={r.now}
                aria-valuetext={r.text}
              >
                <i style={{ width: `${(100 * r.now) / r.max}%` }} />
              </span>
            </li>
          ))}
        </ol>
        <p className="muted">{t.note}</p>
      </div>
    </div>
  );
}
