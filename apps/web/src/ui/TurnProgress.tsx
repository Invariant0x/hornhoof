import { useT } from '../i18n';
import type { TurnView } from '../types';

export function TurnProgress({ tasks }: { tasks: TurnView['tasks'] }) {
  const t = useT();
  const share = tasks.total ? Math.round((tasks.done / tasks.total) * 100) : 0;
  const label = t.tasks.turnProgress(tasks.done, tasks.total);
  return (
    <div className="turn-progress">
      <span className="turn-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={share}>
        <i style={{ width: `${share}%` }} />
      </span>
      <small>{label}</small>
    </div>
  );
}
