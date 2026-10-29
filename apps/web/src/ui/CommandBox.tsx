import { useT } from '../i18n';
import { CopyButton } from './CopyButton';

/* The install command with Copy, and what running it means for the person's subscription. */
export function CommandBox({ command }: { command: string }) {
  const t = useT();
  return (
    <div className="command-box">
      <div className="command">
        <code>{command}</code>
        <CopyButton text={command} />
      </div>
      <p className="trust">{t.subs.trust}</p>
    </div>
  );
}
