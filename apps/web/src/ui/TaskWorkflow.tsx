import type { EchelonFindingsView, EchelonsSnapshot } from '@hornhoof/protocol/echelons';
import { useT } from '../i18n';
import type { CallMark, OneShotStage, Org, TaskDetail } from '../types';
import { phaseName, stageName } from './stage-name';
import { WorkerMark } from './WorkerMark';

const STAGE_CLASS = { pending: 'next', active: 'current', complete: 'passed', skipped: 'skipped' };

export function OneShotMarks({ stage: { stage, fanOut, judge }, calls = [] }: { stage: OneShotStage; calls?: CallMark[] }) {
  const words = useT().workers;
  const slots = new Map<number | 'judge', 'running' | 'waiting'>();
  /* If several tasks use the same place, show running before waiting. The judge has its own place. */
  for (const call of calls) {
    if (call.stage !== stage) continue;
    const key = call.judge ? 'judge' : call.number;
    if (call.startedAt || !slots.has(key)) slots.set(key, call.startedAt ? 'running' : 'waiting');
  }
  return <span className="call-marks">
    {Array.from({ length: fanOut + Number(judge) }, (_, i) => {
      const key = i === fanOut ? 'judge' : i + 1;
      const state = slots.get(key) ?? 'idle';
      const name = key === 'judge' ? words.judge : words.slot(key);
      return <WorkerMark key={key} kind="ghost" className={state} detail={`${name}. ${words[state]}`} />;
    })}
  </span>;
}

function ownerName(id: string, task: TaskDetail, org: Org | null): string | undefined {
  const employee = org?.departments.flatMap(department => department.employees).find(agent => agent.id === id);
  return employee?.name ?? [task.assignee, task.executor].find(agent => agent?.id === id)?.name;
}

/* Stage order and ownership are server facts, independent of an employee's role. */
export function TaskWorkflow({ workflow, task, org }: { workflow: EchelonsSnapshot; task: TaskDetail; org: Org | null }) {
  const someone = useT().tasks.echelons.someone;
  return <WorkflowStages workflow={workflow} resolveOwner={id => ownerName(id, task, org) ?? someone} />;
}

export function WorkflowStages({ workflow, resolveOwner, departmentTask }: {
  workflow: EchelonsSnapshot; resolveOwner(id: string): string; departmentTask?: { number: number; calls?: CallMark[] };
}) {
  const t = useT();
  const labels = t.tasks.echelons;
  const reason = (value: string) => labels.reasons[value as keyof typeof labels.reasons] ?? value;
  const calls = departmentTask?.calls?.filter(call => call.task === departmentTask.number);
  return <section className="fit">
    <h4>{workflow.resultKind === 'coordination' ? labels.coordination : workflow.resultKind === 'turnkey' ? labels.turnkey : labels.heading}</h4>
    <p className="muted" role="status">{phaseName(t, workflow)}</p>
    <ol className="tgates" aria-label={labels.heading}>
      {workflow.stages.map(stage => {
        const current = stage.stage === workflow.stage;
        const owner = current ? workflow.ownerAgentId : stage.ownerAgentId;
        const oneShot = workflow.oneShot?.[stage.stage];
        return <li key={stage.stage} className={STAGE_CLASS[stage.status]} aria-current={current ? 'step' : undefined}>
          {oneShot && !departmentTask && <WorkerMark kind="ghost" />}
          <b>{stageName(t, workflow, stage.stage)}</b>{' '}<span>{labels.statuses[stage.status]}</span>
          {oneShot && departmentTask && <OneShotMarks stage={{ stage: stage.stage, fanOut: oneShot.fanOut, judge: oneShot.judge !== null }} calls={calls} />}
          {owner && <p>{labels.owner(resolveOwner(owner))}</p>}
          {stage.reason && <p className="muted">{reason(stage.reason)}</p>}
        </li>;
      })}
    </ol>
  </section>;
}


export function TaskFindings({ findings, workflow }: { findings: EchelonFindingsView; workflow: EchelonsSnapshot }) {
  const labels = useT().tasks.echelons;
  const stages = ['review', ...(workflow.stages.some(step => step.stage === 'cleanup') ? ['cleanup'] : []), 'security'] as ('review' | 'cleanup' | 'security')[];
  return <section className="fit" aria-label={labels.findings.heading}>
    <h4>{labels.findings.heading}</h4>
    <p>{labels.findings.unique(findings.uniqueReported)}; {labels.findings.confirmed(findings.uniqueConfirmed)}</p>
    {stages.map(stage => <p key={stage}><b>{labels.stages[stage]}</b>: {labels.findings.reported(findings[stage].reported)}; {labels.findings.confirmed(findings[stage].confirmed)}</p>)}
    {findings.issues.map(issue => <p key={`${issue.findingId}:${issue.stage}:${issue.revision}`}><b>{labels.stages[issue.stage]}</b> {issue.path}:{issue.line} {issue.harm}</p>)}
  </section>;
}
