import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useT } from '../i18n';
import { useVersionState, versionText } from '../ui/VersionMark';

function keepFocus(event: ReactKeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'Tab') return;
  const box = event.currentTarget;
  const controls = box.querySelectorAll<HTMLElement>('button, a[href]');
  const first = controls[0];
  const last = controls[controls.length - 1];
  const edge = event.shiftKey ? first : last;
  const active = box.ownerDocument.activeElement;
  if (active !== edge && active !== box) return;
  event.preventDefault();
  const target = event.shiftKey ? last : first;
  target?.focus();
}

export function About({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { version, failed } = useVersionState('/api/updates/current');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="dialog-back" onPointerDown={event => {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      onClose();
    }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="about-title" tabIndex={-1} ref={box} onKeyDown={keepFocus}>
        <header>
          <h2 id="about-title">{t.about.title}</h2>
          <button className="btn small ghost" type="button" aria-label={t.about.close} onClick={onClose}>×</button>
        </header>
        <p>{t.about.description}</p>
        <dl className="facts">
          <dt>{t.about.version}</dt>
          <dd aria-live="polite">{version ? versionText(version) : failed ? t.about.versionFailed : t.common.loading}</dd>
          <dt>{t.about.developer}</dt><dd>Ivan Korol</dd>
          <dt>{t.about.license}</dt><dd><a href="https://github.com/Invariant0x/hornhoof/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">MIT</a></dd>
          <dt>{t.about.code}</dt><dd><a href="https://github.com/Invariant0x/hornhoof" target="_blank" rel="noopener noreferrer">{t.about.code}</a></dd>
          <dt>{t.about.contact}</dt><dd><a href="https://github.com/Invariant0x/hornhoof/issues" target="_blank" rel="noopener noreferrer">{t.about.issues}</a></dd>
          <dt>{t.about.website}</dt><dd><a href="https://hornhoof.org" target="_blank" rel="noopener noreferrer">hornhoof.org</a></dd>
        </dl>
        <p className="muted">{t.about.copyright}</p>
      </div>
    </div>
  );
}
