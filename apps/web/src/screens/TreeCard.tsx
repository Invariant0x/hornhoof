import { Fragment, type ReactNode } from 'react';
import { useLanguage, useT } from '../i18n';
import type { Department, DepartmentTree, TreeAgent } from '../types';
import { ProviderMark } from '../ui/icons';
import { AgentState } from '../ui/AgentState';
import { taskWaitText } from '../ui/task-wait';
import { lanesOf, rowTaskNumber, treeClock, trunkBranch, reviewsOf, type TreePick, type TreeRow } from './tree';
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

function selectedReview(tree: DepartmentTree, pick: TreePick) {
  return reviewsOf(tree).find(r => r.taskId === pick.taskId) ?? tree.review!;
}

function ReviewCard({ tree, department, pick, onOpenTask }: Props) {
  const L = useT().dept.tree, review = selectedReview(tree, pick), openAgent = useOpenAgent();
  const said = review.reviewers.filter(r => r.verdict);
  const pairs: [string, ReactNode][] = [
    [L.cWhat, L.reviewWhat(tree.turn!.branch)],
    [L.cOpened, L.reviewOpened(treeClock(review.openedAt))],
    [L.cWho, review.reviewers.map(r => (
      <Fragment key={r.agent.id}><button type="button" className="linkish" onClick={() => openAgent(r.agent.id)}><TreeWho agent={r.agent} department={department} /></button>{' '}</Fragment>
    ))],
    [L.cSaid, L.said(said.length, review.reviewers.length)],
    [L.cFound, said.reduce((n, r) => n + (r.verdict!.findings ?? 0), 0)],
  ];
  return (
    <>
      <h4><b>#{review.number}</b> {L.reviewH(tree.turn!.number)}</h4>
      <Details pairs={pairs} />
      <p className="say a">{L.reviewSay(department.employees.find(e => e.id === review.head.id)?.name ?? review.head.name)}</p>
      <button type="button" className="btn ghost" onClick={() => onOpenTask(review.taskId)}>{L.openTask}</button>
    </>
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

function rowTitle(row: Pick<TreeRow, 'line' | 'review' | 'activity'>, tree: DepartmentTree, L: ReturnType<typeof useT>['dept']['tree']): string {
  if (row.line) return row.line.title;
  if (row.review) return L.reviewH(tree.turn!.number);
  return row.activity?.task?.title ?? L.noTask;
}

function LaneTask({ row, tree, onOpenTask }: { row: Pick<TreeRow, 'line' | 'review' | 'activity'>; tree: DepartmentTree; onOpenTask(id: string): void }) {
  const L = useT().dept.tree, taskId = row.line?.taskId ?? row.review?.taskId ?? row.activity?.jobId;
  if (!taskId) return <>{L.noTask}</>;
  const number = rowTaskNumber(row);
  return <button type="button" className="linkish" onClick={() => onOpenTask(taskId)}>{number !== undefined && `#${number}`} {rowTitle(row, tree, L)}</button>;
}

function LaneRole({ employee, language }: { employee: Department['employees'][number] | undefined; language: 'en' | 'ru' }) {
  const role = employee?.title?.[language];
  return role && role !== employee?.name ? <p className="say">{role}</p> : null;
}

function LaneCard({ tree, department, pick, onOpenTask, onClose }: Props) {
  const L = useT().dept.tree, { language } = useLanguage(), openAgent = useOpenAgent();
  const row = lanesOf(tree).find(r => r.agent?.id === pick.agentId);
  if (!row?.agent) return null;
  const employee = department.employees.find(e => e.id === row.agent!.id);
  const pairs: [string, ReactNode][] = [
    [L.cTask, <LaneTask row={row} tree={tree} onOpenTask={onOpenTask} />],
    [L.cNow, <LaneDescription agent={row.agent} tree={tree} department={department} line={row.line} />],
  ];
  return (
    <>
      <h4><button type="button" className="linkish" onClick={() => { openAgent(row.agent!.id); onClose?.(); }}><TreeWho agent={row.agent!} department={department} /></button></h4>
      <LaneRole employee={employee} language={language} />
      <Details pairs={pairs} />
    </>
  );
}

const isReviewPick = (pick: TreePick) => pick.kind === 'review' || pick.kind === 'reviewer';

function AgentCard(props: Props) {
  if (!isReviewPick(props.pick)) return <LaneCard {...props} />;
  return (
    <>
      <LaneCard {...props} />
      {reviewsOf(props.tree).length > 0 && <ReviewCard {...props} />}
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
  if (pick.agentId || isReviewPick(pick)) return <AgentCard {...props} />;
  return null;
}
