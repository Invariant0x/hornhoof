import { useEffect, useRef, useState } from 'react';
import { errorText, useT } from '../i18n';
import type { Updates, UpdateCut as Cut } from '../updates';
import { takeEscape } from './escape';

/* Before an update now stops turns that run: how many, and nothing goes without a yes. */
export function UpdateCut({ cut, updates }: { cut: Cut; updates: Updates }) {
  const t = useT();
  const { asking, confirmCut, dropCut } = updates;
  const [failure, setFailure] = useState<unknown>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const before = document.activeElement;
    box.current?.focus();
    return () => {
      if (before instanceof HTMLElement) before.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (takeEscape(e)) dropCut();
    };
    /* On the window, so it goes before Versions, which may be open under this one. */
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dropCut]);

  async function yes() {
    setFailure(null);
    try {
      await confirmCut();
    } catch (err) {
      setFailure(err);
    }
  }

  return (
    <div className="dialog-back" onPointerDown={e => e.target === e.currentTarget && dropCut()}>
      <div className="dialog update-cut" role="alertdialog" aria-modal="true" aria-labelledby="update-cut-title" aria-describedby="update-cut-text" tabIndex={-1} ref={box}>
        <header><h2 id="update-cut-title">{t.updates.cutTitle}</h2></header>
        <p id="update-cut-text">{t.updates.cutText(cut.turns)}</p>
        {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
        <div className="actions">
          <button className="btn small" type="button" disabled={asking} onClick={() => void yes()}>{t.updates.cutYes}</button>
          <button className="btn small ghost" type="button" disabled={asking} onClick={dropCut}>{t.common.cancel}</button>
        </div>
      </div>
    </div>
  );
}
