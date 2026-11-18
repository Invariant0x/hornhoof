import { isStaged } from '@hornhoof/protocol/echelons';
import type { Department, DeptRole, Employee, Team } from '../types';
import type { Point } from '../ui/wires';

/* A department's schema in world pixels. From the top: the head with the people who reach the
   department at its right, the bus from the head to every frame, the pipeline between stages with a numbered gate before each
   check, then a frame per role. Work goes left to right: design, ordinary work, each check in order, then the final check.
   Only sub-units and observers stand apart from the pipeline. */
export const FW = 280, GS = 44, G = 150, CW = 240, CH = 84, PY = 96, HW = 380, HH = 184, PW = 220, PH = 56;
export const BUS = HH + 44, RY = BUS + 44, CY = BUS + 84, FT = CY + 50, FHEAD = 100, REP = 92;
const PEOPLE_Y = 12, PEOPLE_STEP = 66;

export type Placed = { e: Employee; x: number; y: number; cy: number };
/* key: the role's id, 'team:<id>' for a sub-unit frame, or '' for the frame of employees whose role the department does not know. */
/* check: the frame stands behind a gate, as every check after the ordinary work does. */
export type Frame = { key: string; role: DeptRole | null; team?: Team | null; x: number; h: number; stage: number; check?: boolean; members: Placed[] };
/* tr: the bus from the head; tick: from a spine to a chip; pl: the pipeline and the report; gate: between stages. */
export type Line = { cls: 'tr' | 'tick' | 'pl' | 'gate'; pts: Point[]; arrow?: boolean };

export type Schema = {
  head: Employee | null;
  hx: number;
  /* The frames' width and the bottom of the tallest one; right: where the content ends, the people's chips included. */
  w: number;
  h: number;
  right: number;
  frames: Frame[];
  stages: Frame[][];
  lines: Line[];
  vias: Point[];
  /* Diamonds on the pipeline before each check, numbered from the first one. */
  gates: { x: number; n: number }[];
  report: { pts: Point[]; label: Point } | null;
  /* The top left of each person's chip. */
  people: Point[];
};

const outX = (f: Frame) => f.x + FW - 30;
const inX = (f: Frame) => f.x + 30;

const placeMembers = (held: Employee[], x: number): Placed[] =>
  held.map((e, i) => ({ e, x: x + 20, y: FT + FHEAD + i * PY, cy: FT + FHEAD + i * PY + CH / 2 }));

/* Each sub-unit gets its own frame at the left, outside the pipeline stages. */
function splitMembers(d: Department) {
  const all = d.employees.filter(e => e.kind !== 'head');
  const teamIds = new Set(d.teams.map(t => t.id));
  const teamFrames: Frame[] = d.teams.map((team, i) => {
    const held = all.filter(e => e.teamId === team.id);
    const x = i * (FW + GS);
    return { key: `team:${team.id}`, role: null, team, x, h: FHEAD + Math.max(1, held.length) * PY + 8, stage: -1, members: placeMembers(held, x) };
  });
  const last = teamFrames[teamFrames.length - 1];
  const teamEnd = last ? last.x + FW : 0;
  return { teamFrames, members: all.filter(e => !e.teamId || !teamIds.has(e.teamId)), startX: last ? teamEnd + G : 0, teamEnd };
}

type Group = { role: DeptRole | null; key: string }[];

/* Role metadata decides the pipeline, in the order of the development stages: design, ordinary work, each check in its order,
   then the final check. Every check after the work is a numbered gate the work passes in turn. */
function pipelineGroups(known: ReadonlyMap<string, DeptRole>, loose: Employee[]) {
  const roles = [...known.values()].filter(r => r.schema !== 'observer');
  const frames = roles.map(role => ({ key: role.id, role, gate: role.gate, schema: role.schema }));
  const before = frames.filter(f => f.schema === 'before_work');
  const plain = frames.filter(f => f.gate === null && !f.schema);
  const checks = frames.filter(f => f.gate !== null && !f.schema);
  const final = frames.filter(f => f.schema === 'final_check');
  const gateNumbers = [...new Set(checks.map(f => f.gate!))].sort((a, b) => a - b);
  const groups: Group[] = [];
  if (before.length) groups.push(before);
  const workGroup: Group = [...plain, ...(loose.length ? [{ role: null, key: '' }] : [])];
  if (workGroup.length) groups.push(workGroup);
  const firstCheck = groups.length;
  for (const n of gateNumbers) groups.push(checks.filter(f => f.gate === n));
  if (final.length) groups.push(final);
  return { groups, firstCheck };
}

/* Whoever leads a stage of a task now: it stays in its role's frame and is marked there. */
export const leadsStage = (e: Employee): boolean => Boolean(e.task && isStaged(e.task.echelons.resultKind) && e.task.echelons.ownerAgentId === e.id && e.task.echelons.phase === 'active');

/* Observers sit beside the pipeline, like sub-unit frames, and hang on the head's bus as every frame does. */
function observerFrames(known: ReadonlyMap<string, DeptRole>, members: Employee[], startX: number): Frame[] {
  return [...known.values()].filter(r => r.schema === 'observer').map((role, i) => {
    const x = startX + i * (FW + GS);
    const held = members.filter(e => e.roleId === role.id);
    return { key: role.id, role, x, h: FHEAD + Math.max(1, held.length) * PY + 8, stage: -1, members: placeMembers(held, x) };
  });
}

export function schemaLayout(d: Department, people: number): Schema {
  const head = d.employees.find(e => e.kind === 'head') ?? null;
  const { teamFrames, members, startX, teamEnd } = splitMembers(d);
  const known = new Map(d.roles.filter(r => members.some(e => e.roleId === r.id)).map(r => [r.id, r]));
  const loose = members.filter(e => !e.roleId || !known.has(e.roleId));
  const { groups, firstCheck } = pipelineGroups(known, loose);
  const observers = observerFrames(known, members, startX);
  const lastObserver = observers[observers.length - 1];
  const outsideEnd = lastObserver ? lastObserver.x + FW : teamEnd;
  const pipelineStart = lastObserver ? outsideEnd + G : startX;

  const stages: Frame[][] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let x = pipelineStart;
  for (const [k, group] of groups.entries()) {
    starts.push(x);
    const frames = group.map(g => {
      const held = g.role ? members.filter(e => e.roleId === g.role!.id) : loose;
      const frame: Frame = {
        key: g.key,
        role: g.role,
        x,
        h: FHEAD + Math.max(1, held.length) * PY + 8,
        stage: k,
        check: k >= firstCheck,
        members: placeMembers(held, x),
      };
      x += FW + GS;
      return frame;
    });
    ends.push(x - GS);
    x = x - GS + G;
    stages.push(frames);
  }
  const stageFrames = stages.flat();
  const frames = [...teamFrames, ...observers, ...stageFrames];
  const w = ends.length ? ends[ends.length - 1]! : outsideEnd;
  const h = FT + Math.max(0, ...frames.map(f => f.h));
  /* Over the middle of all the frames, sub-units and observers included; a narrow department keeps the head whole. */
  const hx = Math.max(HW / 2, w / 2);

  const lines: Line[] = [];
  const vias: Point[] = [];
  /* Between stages, a dotted divider; on the pipeline, a numbered diamond before every check. */
  const gates: Schema['gates'] = [];
  for (let k = 1; k < stages.length; k++) {
    const sx = (ends[k - 1]! + starts[k]!) / 2;
    lines.push({ cls: 'gate', pts: [[sx, RY + 16], [sx, h]] });
    if (k >= firstCheck) gates.push({ x: sx, n: gates.length + 1 });
  }
  /* The head leads every frame, a sub-unit's and an observer's too: down to the bus, along it, and down each frame's spine
     to its chips. */
  if (frames.length) {
    lines.push({ cls: 'tr', pts: [[hx, HH], [hx, BUS]] });
    lines.push({ cls: 'tr', pts: [[Math.min(hx, frames[0]!.x + 10), BUS], [Math.max(hx, frames[frames.length - 1]!.x + 10), BUS]] });
    for (const f of frames) {
      const end = f.members.length ? f.members[f.members.length - 1]!.cy : FT + 40;
      lines.push({ cls: 'tr', pts: [[f.x + 10, BUS], [f.x + 10, end]] });
      for (const m of f.members) lines.push({ cls: 'tick', pts: [[f.x + 10, m.cy], [m.x, m.cy]] });
      vias.push([f.x + 10, BUS]);
    }
    vias.push([hx, BUS]);
  }

  const px = hx + HW / 2 + 40;
  if (people) {
    lines.push({ cls: 'tr', pts: [[hx + HW / 2, 40], [px - 14, 40], [px - 14, 40 + (people - 1) * PEOPLE_STEP]] });
    for (let k = 0; k < people; k++) lines.push({ cls: 'tick', pts: [[px - 14, 40 + k * PEOPLE_STEP], [px, 40 + k * PEOPLE_STEP]] });
  }

  /* The pipeline: each stage's outputs meet on one line and go down into the next stage's inputs. */
  for (let k = 0; k < stages.length - 1; k++) {
    const a = stages[k]!, b = stages[k + 1]!;
    for (const f of a) lines.push({ cls: 'pl', pts: [[outX(f), FT], [outX(f), CY]] });
    lines.push({ cls: 'pl', pts: [[Math.min(...a.map(outX)), CY], [Math.max(...b.map(inX)), CY]] });
    for (const f of b) lines.push({ cls: 'pl', pts: [[inX(f), CY], [inX(f), FT]], arrow: true });
  }

  /* The report: from the last stage frame up and over into the head, or straight up when the head sits above it. Over, it
     comes into the head's right edge under the last person's chip there, or under the head when the chips reach below it. */
  let report: Schema['report'] = null;
  const last = stageFrames[stageFrames.length - 1];
  if (head && last) {
    const ox = outX(last), edge = hx + HW / 2;
    const ry = REP + Math.max(0, people - 1) * PEOPLE_STEP, under = (HH + BUS) / 2;
    if (ox <= edge) report = { pts: [[ox, FT], [ox, HH]], label: [ox, (FT + HH) / 2] };
    else if (ry < HH) report = { pts: [[ox, FT], [ox, ry], [edge, ry]], label: [(ox + edge) / 2, ry] };
    else report = { pts: [[ox, FT], [ox, under], [edge - 30, under], [edge - 30, HH]], label: [ox, (FT + under) / 2] };
  }

  const peopleAt: Point[] = Array.from({ length: people }, (_, k) => [px, PEOPLE_Y + k * PEOPLE_STEP]);
  const right = Math.max(w, hx + HW / 2, people ? px + PW : 0);
  return { head, hx, w, h, right, frames, stages, lines, vias, gates, report, people: peopleAt };
}

type Spot = { f: Frame; m: Placed };

/* From the head down to the bus, along it to the frame's spine and down that to the employee, in any frame. */
function memberDown(s: Schema, at: Spot | null): Point[] | null {
  if (!at) return null;
  const sx = at.f.x + 10;
  return [[s.hx, HH - 30], [s.hx, BUS], [sx, BUS], [sx, at.m.cy], [at.m.x + 14, at.m.cy]];
}

function memberOnward(s: Schema, at: Spot | null): Point[] | null {
  if (!at) return null;
  if (at.f.stage < 0) return [...memberDown(s, at)!].reverse();
  const next = s.stages[at.f.stage + 1];
  if (next) return [[outX(at.f), FT], [outX(at.f), CY], [inX(next[0]!), CY], [inX(next[0]!), FT]];
  return s.report?.pts ?? null;
}

function wayToHead(s: Schema, a: Spot): Point[] | null {
  if (a.f.stage >= 0 && !s.stages[a.f.stage + 1]) return s.report?.pts ?? null;
  return [...memberDown(s, a)!].reverse();
}

const canStepBetween = (a: Spot, b: Spot | null): b is Spot =>
  !!b && a.f.stage >= 0 && b.f.stage >= 0 && b.f.stage !== a.f.stage;

/* The paths a pulse runs along when an employee's work moves. */
export function stepPaths(s: Schema) {
  const spot = (id: string): Spot | null => {
    for (const f of s.frames) {
      const m = f.members.find(x => x.e.id === id);
      if (m) return { f, m };
    }
    return null;
  };
  function toMember(id: string): Point[] | null {
    return memberDown(s, spot(id));
  }
  function onward(id: string): Point[] | null {
    return memberOnward(s, spot(id));
  }
  return {
    /* The head hands an employee a task. */
    toMember,
    /* An employee hands its work on: to the next stage, or from the last one to the head. */
    onward,
    /* Where a message between two of its agents runs: down from the head, up to it (along the report line from the last
       stage), on to a later stage or back to an earlier one. */
    way(from: string, to: string): Point[] | null {
      const head = s.head?.id;
      if (from === head) return toMember(to);
      const a = spot(from);
      if (!a) return null;
      if (to === head) return wayToHead(s, a);
      const b = spot(to);
      if (!canStepBetween(a, b)) return null;
      return b.f.stage > a.f.stage ? onward(from) : [...wayToHead(s, a)!, ...memberDown(s, b)!];
    },
  };
}

/* The arrowhead at the end of a line. */
export function arrowD(pts: Point[]): string {
  const b = pts[pts.length - 1]!, a = pts[pts.length - 2]!;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len, s = 10, w = 5;
  const r = (v: number) => Math.round(v * 10) / 10;
  return `M ${b[0]} ${b[1]} L ${r(b[0] - ux * s - uy * w)} ${r(b[1] - uy * s + ux * w)} L ${r(b[0] - ux * s + uy * w)} ${r(b[1] - uy * s - ux * w)} Z`;
}
