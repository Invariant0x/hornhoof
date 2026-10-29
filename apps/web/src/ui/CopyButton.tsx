import { useState } from 'react';
import { useT } from '../i18n';

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1600);
    } catch {
      /* Clipboard can be blocked; the text stays selectable on the page. */
    }
  }
  return (
    <button className="btn small ghost" type="button" onClick={copy} aria-label={label ?? t.common.copy}>
      {done ? t.common.copied : (label ?? t.common.copy)}
    </button>
  );
}
