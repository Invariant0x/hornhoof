import type { EchelonsSnapshot } from '@hornhoof/protocol/echelons';
import { useT } from '../i18n';
import type { Org, TaskDetail } from '../types';

const STAGE_CLASS = { pending: 'next', active: 'current', complete: 'passed', skipped: 'skipped' };

function ownerName(id: string, task: TaskDetail, org: Org | null): string {
  const employee = org?.departments.flatMap(department => department.employees).find(agent => agent.id === id);
  return employee?.name ?? [task.assignee, task.executor].find(agent => agent?.id === id)?.name ?? id;
}

/* Stage order and ownership are server facts, independent of an employee's role. */
export function TaskWorkflow({ workflow, task, org }: { workflow: EchelonsSnapshot; task: TaskDetail; org: Org | null }) {
  const labels = useT().tasks.echelons;
  const reason = (value: string) => labels.reasons[value as keyof typeof labels.reasons] ?? value;
  return <section className="fit">
    <h4>{workflow.resultKind === 'coordination' ? labels.coordination : labels.heading}</h4>
    <p className="muted" role="status">{labels.phases[workflow.phase]}</p>
    <ol className="tgates" aria-label={labels.heading}>
      {workflow.stages.map(stage => {
        const current = stage.stage === workflow.stage;
        const owner = current ? workflow.ownerAgentId : stage.ownerAgentId;
        return <li key={stage.stage} className={STAGE_CLASS[stage.status]} aria-current={current ? 'step' : undefined}>
          <b>{labels.stages[stage.stage]}</b>{' '}<span>{labels.statuses[stage.status]}</span>
          {owner && <p>{labels.owner(ownerName(owner, task, org))}</p>}
          {stage.reason && <p className="muted">{reason(stage.reason)}</p>}
        </li>;
      })}
    </ol>
  </section>;
}
