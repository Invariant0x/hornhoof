import { useState } from 'react';

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
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
    <button className="btn small ghost" type="button" onClick={copy} aria-label={label}>
      {done ? 'Copied' : label}
    </button>
  );
}
