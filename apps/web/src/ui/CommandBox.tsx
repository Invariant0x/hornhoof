import { useT } from '../i18n';
import { CopyButton } from './CopyButton';

/* The install command with Copy, and what running it means for the person's subscription, or for their machine. */
export function CommandBox({ command, trust }: { command: string; trust?: string }) {
  const t = useT();
  return (
    <div className="command-box">
      <div className="command">
        <code>{command}</code>
        <CopyButton text={command} />
      </div>
      <p className="trust">{trust ?? t.subs.trust}</p>
    </div>
  );
}
