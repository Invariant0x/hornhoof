import { Fragment, type ReactNode } from 'react';
import { useT } from '../i18n';
import type { Department, DepartmentTree, TreeAgent } from '../types';
import { ProviderMark } from '../ui/icons';
import { treeClock, trunkBranch, reviewsOf, type TreePick } from './tree';
import { useOpenAgent } from './AgentWindowContext';

type Props = { tree: DepartmentTree; department: Department; pick: TreePick; onOpenTask(id: string): void };

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

const isReviewPick = (pick: TreePick) => pick.kind === 'review' || pick.kind === 'reviewer';

export function TreeCardBody(props: Props) {
  const { tree, pick, department } = props, L = useT().dept.tree;
  if (isReviewPick(pick)) return reviewsOf(tree).length > 0 && <ReviewCard {...props} />;
  if (pick.kind === 'main') {
    return (
      <>
        <h4>{trunkBranch(department)}</h4>
        <p className="say">{L.mainSay(tree.turn!.number)}</p>
      </>
    );
  }
  if (pick.kind === 'turn') return <TurnCard tree={tree} department={department} />;
  return null;
}
