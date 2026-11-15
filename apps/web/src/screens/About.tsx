import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useT } from '../i18n';
import { useVersionState, versionText } from '../ui/VersionMark';
import { takeEscape } from '../ui/escape';
import { useScrollbarRoom } from '../ui/scrollbar-room';
import { FeedbackForm, useSteady } from './Feedback';

const FOCUSABLE = ':is(button, input, textarea, select):not(:disabled), a[href]';

function keepFocus(event: ReactKeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'Tab') return;
  const box = event.currentTarget;
  const controls = box.querySelectorAll<HTMLElement>(FOCUSABLE);
  const first = controls[0];
  const last = controls[controls.length - 1];
  const edge = event.shiftKey ? first : last;
  const active = box.ownerDocument.activeElement;
  if (active !== edge && active !== box) return;
  event.preventDefault();
  const target = event.shiftKey ? last : first;
  target?.focus();
}

/* Writing to Hornhoof's developers inside About, closed to one sentence and a button until the person opens it. Open, the
   focus goes to the first choice of the form; Cancel, and Done once it is sent, close it again and give the focus back to
   its button. */
function AboutFeedback({ inbox }: { inbox: boolean }) {
  const t = useT();
  const id = useId();
  const part = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return;
    part.current?.querySelector<HTMLElement>(open ? 'button, input, textarea' : '.form-foot > .btn')?.focus();
  }, [open]);
  const turn = (next: boolean) => {
    moved.current = true;
    setOpen(next);
  };
  return (
    <section className="about-feedback" aria-labelledby={id} ref={part}>
      <h3 id={id}>{t.feedback.section}</h3>
      {open ? (
        <FeedbackForm inbox={inbox} onDone={() => turn(false)} onCancel={() => turn(false)} />
      ) : (
        <>
          <p>{t.feedback.intro}</p>
          <div className="form-foot">
            <button className="btn ghost" type="button" onClick={() => turn(true)}>{t.feedback.write}</button>
          </div>
        </>
      )}
    </section>
  );
}

/* About Hornhoof, as Design's reference draws it: what it is, its version, license, code and site, its author, a line,
   then writing to its developers. inbox: this is Hornhoof's own installation, where what is written goes into its own
   inbox. */
export function About({ inbox, onClose }: { inbox: boolean; onClose: () => void }) {
  const t = useT();
  const { version, failed } = useVersionState('/api/updates/current');
  const box = useRef<HTMLDivElement>(null);
  useScrollbarRoom(box);
  /* The same function for the window's whole life: a screen behind it drawn again does not take the focus from what the
     person types. */
  const close = useSteady(onClose);
  useEffect(() => {
    box.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (!takeEscape(event)) return;
      close();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [close]);

  return (
    <div className="dialog-back" onPointerDown={event => {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      onClose();
    }}>
      <div className="dialog about" role="dialog" aria-modal="true" aria-labelledby="about-title" tabIndex={-1} ref={box} onKeyDown={keepFocus}>
        <header>
          <h2 id="about-title">{t.about.title}</h2>
          <button className="btn ghost icon-btn" type="button" aria-label={t.about.close} onClick={onClose}>×</button>
        </header>
        <p>{t.about.description}</p>
        <dl className="facts">
          <dt>{t.about.version}</dt>
          <dd aria-live="polite">{version ? <bdi dir="ltr">{versionText(version)}</bdi> : failed ? t.about.versionFailed : t.common.loading}</dd>
          <dt>{t.about.license}</dt><dd><a href="https://github.com/Invariant0x/hornhoof/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">MIT</a></dd>
          <dt>{t.about.code}</dt><dd><a href="https://github.com/Invariant0x/hornhoof" target="_blank" rel="noopener noreferrer">{t.about.code}</a></dd>
          <dt>{t.about.website}</dt><dd><a href="https://hornhoof.org" target="_blank" rel="noopener noreferrer">hornhoof.org</a></dd>
        </dl>
        <p className="about-author">{t.about.author}</p>
        <hr className="about-sep" />
        <AboutFeedback inbox={inbox} />
      </div>
    </div>
  );
}
