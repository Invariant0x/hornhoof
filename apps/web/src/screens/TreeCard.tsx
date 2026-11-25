import { Fragment, type ReactNode } from 'react';
import { sayIf } from '@hornhoof/protocol';
import { useLanguage, useT, type Language } from '../i18n';
import type { Department, DepartmentTree, TreeAgent } from '../types';
import { ProviderMark } from '../ui/icons';
import { TaskFindings, WorkflowStages } from '../ui/TaskWorkflow';
import { AgentState } from '../ui/AgentState';
import { taskWaitText } from '../ui/task-wait';
import { lanesOf, rowTaskNumber, treeClock, trunkBranch, type TreePick, type TreeRow } from './tree';
import { useOpenAgent } from './AgentWindowContext';

type Props = { tree: DepartmentTree; department: Department; pick: TreePick; onOpenTask(id: string): void; onClose?(): void };

export function TreeWho({ agent, department }: { agent: TreeAgent; department: Department }) {
  const employee = department.employees.find(e => e.id === agent.id);
  return (
    <>
      {employee?.name ?? agent.name}
      <ProviderMark provider={employee?.provider ?? null} />
    </>
  );
}

function Details({ pairs }: { pairs: [string, ReactNode][] }) {
  return (
    <dl>
      {pairs.map(([name, value]) => (
        <Fragment key={name}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function TurnCard({ tree, department }: Pick<Props, 'tree' | 'department'>) {
  const L = useT().dept.tree, turn = tree.turn!;
  const pairs: [string, ReactNode][] = [
    [L.cOpened, treeClock(turn.startedAt)],
    [L.cIn, L.inTurn(tree.lines.filter(l => l.mergedAt).length, tree.lines.length)],
  ];
  return (
    <>
      <h4>{turn.branch}</h4>
      <Details pairs={pairs} />
      <p className="say">{L.turnSay(turn.number, treeClock(turn.startedAt), trunkBranch(department))}</p>
    </>
  );
}

function LaneDescription({ agent, tree, department, line }: { agent: TreeAgent; tree: DepartmentTree; department: Department; line?: DepartmentTree['lines'][number] }) {
  const L = useT().dept.tree, external = line?.externalWait;
  if (external && external.until > tree.now) {
    const text = taskWaitText(useT(), external, treeClock(external.until));
    return <span className="ast calm" title={text}>{text}</span>;
  }
  const wait = tree.waiting?.find(w => w.agent.id === agent.id);
  if (!wait) return <AgentState agent={department.employees.find(e => e.id === agent.id)} serverNow={tree.now} />;
  const text = L.waitingFor(wait.waitsForAgent.name, treeClock(wait.from));
  return <span className="ast calm" title={text}>{text}</span>;
}

function rowTitle(row: Pick<TreeRow, 'line' | 'activity'>, L: ReturnType<typeof useT>['dept']['tree']): string {
  if (row.line) return row.line.title;
  return row.activity?.task?.title ?? L.noTask;
}

function LaneTask({ row, onOpenTask }: { row: Pick<TreeRow, 'line' | 'activity'>; onOpenTask(id: string): void }) {
  const L = useT().dept.tree, taskId = row.line?.taskId ?? row.activity?.task?.id;
  if (!taskId) return <>{L.noTask}</>;
  const number = rowTaskNumber(row);
  return <button type="button" className="linkish" onClick={() => onOpenTask(taskId)}>{number !== undefined && `#${number}`} {rowTitle(row, L)}</button>;
}

function LaneRole({ employee, language }: { employee: Department['employees'][number] | undefined; language: Language }) {
  const role = sayIf(employee?.title, language);
  return role && role !== employee?.name ? <p className="say">{role}</p> : null;
}

function workflowOwner(id: string, department: Department, tree: DepartmentTree): string {
  return department.employees.find(agent => agent.id === id)?.name ?? tree.activity?.find(activity => activity.agent.id === id)?.agent.name ?? id;
}

function LaneCard({ tree, department, pick, onOpenTask, onClose }: Props) {
  const L = useT().dept.tree, { language } = useLanguage(), openAgent = useOpenAgent();
  const row = lanesOf(tree).find(r => r.agent?.id === pick.agentId);
  if (!row?.agent) return null;
  const employee = department.employees.find(e => e.id === row.agent!.id);
  const pairs: [string, ReactNode][] = [
    [L.cTask, <LaneTask row={row} onOpenTask={onOpenTask} />],
    [L.cNow, <LaneDescription agent={row.agent} tree={tree} department={department} line={row.line} />],
  ];
  return (
    <>
      <h4><button type="button" className="linkish name-link" onClick={() => { openAgent(row.agent!.id); onClose?.(); }}><TreeWho agent={row.agent!} department={department} /></button></h4>
      <LaneRole employee={employee} language={language} />
      <Details pairs={pairs} />
      {row.line && <>
        <WorkflowStages workflow={row.line.echelons} resolveOwner={id => workflowOwner(id, department, tree)}
          departmentTask={{ number: row.line.number, calls: department.calls }} />
        <TaskFindings workflow={row.line.echelons} findings={row.line.echelonFindings} />
      </>}
    </>
  );
}

export function TreeCardBody(props: Props) {
  const { tree, pick, department } = props, L = useT().dept.tree;
  if (pick.kind === 'main') {
    return (
      <>
        <h4>{trunkBranch(department)}</h4>
        <p className="say">{L.mainSay(tree.turn!.number)}</p>
      </>
    );
  }
  if (pick.kind === 'turn') return <TurnCard tree={tree} department={department} />;
  if (pick.agentId) return <LaneCard {...props} />;
  return null;
}
