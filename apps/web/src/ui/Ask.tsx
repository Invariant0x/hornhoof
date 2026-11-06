import { useT } from '../i18n';

/* A question in place of the button that asked it: yes, or cancel. */
export function Ask({ text, yes, onYes, onNo }: { text: string; yes: string; onYes: () => void; onNo: () => void }) {
  const t = useT();
  return (
    <div className="ask">
      <span className="entry-main">{text}</span>
      <div className="entry-actions" role="group" aria-label={text}>
        <button className="btn" type="button" onClick={onYes}>{yes}</button>
        <button className="btn ghost" type="button" onClick={onNo}>{t.common.cancel}</button>
      </div>
    </div>
  );
}
