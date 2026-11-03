import { Fragment, type ReactNode } from 'react';
import { useT } from '../i18n';
import type { Department, DepartmentTree, TreeAgent, TreeLine, TreeSegment } from '../types';
import { ProviderMark } from '../ui/icons';
import { currentSegment, secondsBetween, treeClock, trunkBranch, type TreePick } from './tree';

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

function LineTimes({ segments, now }: { segments: TreeSegment[]; now: string }) {
  const L = useT().dept.tree;
  const count = (kind: TreeSegment['kind']) => segments
    .filter(s => s.kind === kind)
    .reduce((n, s) => n + secondsBetween(s.from, s.to ?? now), 0) / 60;
  return (
    <p className="times">
      <span>{L.tWork} <b>{L.dur(count('work'))}</b></span>
      <span>{L.tWait} <b>{L.dur(count('after') + count('person'))}</b></span>
      <span>{L.tStall} <b>{L.dur(count('stall'))}</b></span>
    </p>
  );
}

function lineState(line: TreeLine, tree: DepartmentTree, L: ReturnType<typeof useT>['dept']['tree']): string {
  if (line.mergedAt) return L.st.done(tree.turn!.branch);
  if (line.doneAt) return L.st.doneSal;
  const s = currentSegment(line.segments, tree.now);
  const duration = L.dur(s ? secondsBetween(s.from, tree.now) / 60 : 0);
  if (s?.kind === 'stall') return L.st.stall(duration);
  if (s?.kind === 'person') return L.st.person(duration);
  if (s?.kind === 'after') return line.waitsFor.map(L.st.after).join(', ');
  return L.st.work;
}

function lineStateClass(line: TreeLine, segment: TreeSegment | undefined): string {
  if (segment?.kind === 'stall') return 'st';
  if (segment?.kind === 'person') return 'ps';
  if (line.mergedAt || line.doneAt) return 'ok';
  if (segment?.kind === 'after') return '';
  return 'w';
}

function WorkCard({ tree, department, line, onOpenTask }: Omit<Props, 'pick'> & { line: TreeLine }) {
  const L = useT().dept.tree, s = currentSegment(line.segments, tree.now);
  const last = line.moves.filter(m => m.at <= tree.now).sort((a, b) => b.at.localeCompare(a.at))[0];
  const moves: Record<string, string> = L.mv;
  const branch = tree.repository && line.branch ? `${line.branch} → ${tree.turn!.branch}` : L.noRepo;
  const pairs: [string, ReactNode][] = [
    [L.cWho, <TreeWho agent={line.agent} department={department} />],
    [L.cNow, <span className={`tstate ${lineStateClass(line, s)}`}>{lineState(line, tree, L)}</span>],
    [L.cBranch, branch],
    [L.cLast, last
      ? `${treeClock(last.at)}, ${moves[last.kind] ?? last.kind}${last.text ? `: ${last.text}` : ''}`
      : treeClock(line.createdAt)],
  ];
  if (line.live || line.lastActionAt) pairs.push([L.cAgent, line.live ? L.agentNow : L.agentQuiet(treeClock(line.lastActionAt!))]);
  if (line.doneAt) pairs.push([L.cWhen, L.doneAt(treeClock(line.doneAt))]);
  if (line.part) pairs.push([L.cPart, `#${line.part.number} ${line.part.title}`]);
  const question = line.moves.filter(m => m.kind === 'asked').at(-1)?.text;
  return (
    <>
      <h4><b>#{line.number}</b> {line.title}</h4>
      <Details pairs={pairs} />
      {s?.kind === 'stall' && <p className="say a">{L.stallSay}</p>}
      {s?.kind === 'person' && question && <p className="say p">{question}</p>}
      {s?.kind === 'after' && <p className="say">{line.waitsFor.map(L.afterSay).join(' ')}</p>}
      <LineTimes segments={line.segments} now={tree.now} />
      <div className="acts">
        <button type="button" className="btn ghost" onClick={() => onOpenTask(line.taskId)}>{L.openTask}</button>
      </div>
    </>
  );
}

function ReviewCard({ tree, department, pick, onOpenTask }: Props) {
  const L = useT().dept.tree, review = tree.review!;
  const reviewer = review.reviewers.find(r => r.agent.id === pick.agentId);
  const pairs: [string, ReactNode][] = [[L.cWhat, L.reviewWhat(tree.turn!.branch)]];
  if (reviewer) {
    const verdict = reviewer.verdict;
    pairs.unshift(
      [L.cWho, <TreeWho agent={reviewer.agent} department={department} />],
      [L.cNow, verdict
        ? L.verdict(verdict.pass, verdict.findings)
        : L.st.review(L.dur(secondsBetween(review.openedAt, tree.now) / 60))],
    );
    if (verdict) {
      const duration = L.dur(secondsBetween(review.openedAt, verdict.at) / 60);
      const interval = L.idleClosed(treeClock(review.openedAt), treeClock(verdict.at));
      pairs.push([L.cChecked, `${duration}, ${interval}`]);
    }
  } else {
    const said = review.reviewers.filter(r => r.verdict);
    pairs.push(
      [L.cOpened, L.reviewOpened(treeClock(review.openedAt))],
      [L.cWho, review.reviewers.map(r => (
        <span key={r.agent.id}><TreeWho agent={r.agent} department={department} /> </span>
      ))],
      [L.cSaid, L.said(said.length, review.reviewers.length)],
      [L.cFound, said.reduce((n, r) => n + (r.verdict!.findings ?? 0), 0)],
    );
  }
  return (
    <>
      <h4><b>#{review.number}</b> {L.reviewH(tree.turn!.number)}</h4>
      <Details pairs={pairs} />
      {!reviewer && (
        <p className="say a">
          {L.reviewSay(department.employees.find(e => e.id === review.head.id)?.name ?? review.head.name)}
        </p>
      )}
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

function MoveCard({ tree, department, pick, line, onOpenTask }: Props & { line: TreeLine }) {
  const L = useT().dept.tree, turn = tree.turn!;
  const move = pick.moveIndex == null ? undefined : line.moves[pick.moveIndex];
  const moves: Record<string, string> = L.mv;
  const title = pick.kind === 'merge' ? L.mergeH(line.number, turn.branch) : moves[move?.kind ?? ''] ?? move?.kind;
  const pairs: [string, ReactNode][] = [
    [L.cWhen, treeClock(move?.at ?? line.mergedAt!)],
    [L.cWho, <TreeWho agent={line.agent} department={department} />],
    [L.cTask, `#${line.number} ${line.title}`],
  ];
  return (
    <>
      <h4>{title}</h4>
      <Details pairs={pairs} />
      <p className="say">{pick.kind === 'merge' ? L.mergeSay(turn.branch) : move?.text}</p>
      <button type="button" className="btn ghost" onClick={() => onOpenTask(line.taskId)}>{L.openTask}</button>
    </>
  );
}

export function TreeCardBody(props: Props) {
  const { tree, pick, department } = props, L = useT().dept.tree;
  const line = tree.lines.find(l => l.taskId === pick.taskId);
  if (pick.kind === 'review' || pick.kind === 'reviewer') return tree.review && <ReviewCard {...props} />;
  if (pick.kind === 'main') {
    return (
      <>
        <h4>{trunkBranch(department)}</h4>
        <p className="say">{L.mainSay(tree.turn!.number)}</p>
      </>
    );
  }
  if (pick.kind === 'turn') return <TurnCard tree={tree} department={department} />;
  if (!line) return null;
  if (pick.kind === 'line') return <WorkCard {...props} line={line} />;
  return <MoveCard {...props} line={line} />;
}
