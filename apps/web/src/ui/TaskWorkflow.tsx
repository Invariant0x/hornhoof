import { useT } from '../i18n';
import type { TaskEchelons } from '../echelons';
import type { Org, TaskDetail } from '../types';

const STAGE_CLASS = { pending: 'next', active: 'current', complete: 'passed', skipped: 'skipped' };

function ownerName(id: string, task: TaskDetail, org: Org | null): string {
  const employee = org?.departments.flatMap(department => department.employees).find(agent => agent.id === id);
  if (employee) return employee.name;
  return [task.assignee, task.executor, ...task.gates].find(agent => agent?.id === id)?.name ?? id;
}

/* The cursor and the stage history come from the engine, independently of legacy gate numbers. */
export function TaskWorkflow({ workflow, task, org }: { workflow: TaskEchelons; task: TaskDetail; org: Org | null }) {
  const labels = useT().tasks.echelons;
  return <section className="fit">
    <h4>{labels.heading}</h4>
    <p className="muted" role="status">{labels.phases[workflow.phase]}</p>
    <ol className="tgates" aria-label={labels.heading}>
      {workflow.stages.map(stage => {
        const current = stage.stage === workflow.stage;
        const ownerId = current ? workflow.ownerAgentId : stage.ownerAgentId;
        return <li key={stage.stage} className={STAGE_CLASS[stage.status]} aria-current={current ? 'step' : undefined}>
          <b>{labels.stages[stage.stage]}</b>{' '}<span>{labels.statuses[stage.status]}</span>
          {ownerId && <p>{labels.owner(ownerName(ownerId, task, org))}</p>}
          {stage.reason && <p className="muted">{stage.reason}</p>}
        </li>;
      })}
    </ol>
  </section>;
}
