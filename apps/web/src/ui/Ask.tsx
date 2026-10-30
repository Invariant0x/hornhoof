import { useT } from '../i18n';

/* A question in place of the button that asked it: yes, or cancel. */
export function Ask({ text, yes, onYes, onNo }: { text: string; yes: string; onYes: () => void; onNo: () => void }) {
  const t = useT();
  return (
    <div className="ask">
      <span>{text}</span>
      <button className="btn small" type="button" onClick={onYes}>{yes}</button>
      <button className="btn small ghost" type="button" onClick={onNo}>{t.common.cancel}</button>
    </div>
  );
}
