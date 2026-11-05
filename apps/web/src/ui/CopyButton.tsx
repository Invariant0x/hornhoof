import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      if (!live.current) return;
      clearTimeout(timer.current);
      setDone(true);
      timer.current = setTimeout(() => setDone(false), 1600);
    } catch {
      /* Clipboard can be blocked; the text stays selectable on the page. */
    }
  }
  return (
    <button className="btn small ghost" type="button" onClick={() => void copy()} aria-label={label ?? t.common.copy}>
      {done ? t.common.copied : (label ?? t.common.copy)}
    </button>
  );
}
