import type { CSSProperties } from 'react';
import { useT } from '../i18n';
import { EmployeeMarkIcon, GeneralistMarkIcon, GhostMarkIcon, TrackerIcon } from './icons';

const ICONS = { employee: EmployeeMarkIcon, generalist: GeneralistMarkIcon, ghost: GhostMarkIcon };

export const employeeKind = (turnkey?: boolean) => turnkey ? 'generalist' : 'employee';

export function WorkerMark({ kind, detail, decorative, className, style }: { kind: keyof typeof ICONS; detail?: string; decorative?: boolean; className?: string; style?: CSSProperties }) {
  const words = useT().workers;
  const label = detail ? `${words[kind]}. ${detail}` : words[kind];
  const Icon = ICONS[kind];
  return (
    <span className={className ? `worker-mark ${className}` : 'worker-mark'} data-worker-kind={kind} style={style}
      role={decorative ? undefined : 'img'} aria-hidden={decorative || undefined} aria-label={decorative ? undefined : label} title={decorative ? undefined : label}>
      <Icon />
    </span>
  );
}

export function WorkerLegend() {
  const words = useT().workers;
  return (
    <details className="worker-legend">
      <summary><TrackerIcon name="chevron" />{words.legend}</summary>
      <ul>
        {(Object.keys(ICONS) as (keyof typeof ICONS)[]).map(kind => <li key={kind}><WorkerMark kind={kind} decorative /><span>{words[kind]}</span></li>)}
      </ul>
    </details>
  );
}
