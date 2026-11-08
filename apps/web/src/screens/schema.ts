import { ECHELON_STAGES, type EchelonStage, type EchelonStep } from '@hornhoof/protocol/echelons';
import type { Department, DeptRole, Employee, Team } from '../types';
import type { Point } from '../ui/wires';

/* A department's schema in world pixels, laid out like the prototype. From the top: the head with the people who reach the
   department at its right, the bus from the head to every frame, the pipeline between actual task stages, then frames for their current owners. Idle staff, sub-units and observers remain outside it. */
export const FW = 280, GS = 44, G = 150, CW = 240, CH = 84, PY = 96, HW = 380, HH = 184, PW = 220, PH = 56;
export const BUS = HH + 44, RY = BUS + 44, CY = BUS + 84, FT = CY + 50, FHEAD = 100, REP = 92;
const PEOPLE_Y = 12, PEOPLE_STEP = 66;

export type Placed = { e: Employee; x: number; y: number; cy: number };
/* key: the role's id, 'team:<id>' for a sub-unit frame, or '' for the frame of employees whose role the department does not know. */
export type Frame = { key: string; role: DeptRole | null; team?: Team | null; x: number; h: number; stage: number; echelon?: EchelonStage; status?: EchelonStep['status']; members: Placed[] };
/* tr: the bus from the head; tick: from a spine to a chip; pl: the pipeline and the report; rl: the way back; gate: between stages. */
export type Line = { cls: 'tr' | 'tick' | 'pl'; pts: Point[]; arrow?: boolean };

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

/* Direct lines from the head's left edge into sub-unit and observer frames, with no stage bus or pipeline connection. */
function addTeamLines(lines: Line[], vias: Point[], teamFrames: Frame[], hx: number) {
  for (const [i, tf] of teamFrames.entries()) {
    const y = HH / 2 - i * 20;
    const end = tf.members.length ? tf.members[tf.members.length - 1]!.cy : FT + 40;
    lines.push({ cls: 'tr', pts: [[hx - HW / 2, y], [tf.x + 10, y], [tf.x + 10, FT]], arrow: true });
    lines.push({ cls: 'tr', pts: [[tf.x + 10, FT], [tf.x + 10, end]] });
    for (const m of tf.members) lines.push({ cls: 'tick', pts: [[tf.x + 10, m.cy], [m.x, m.cy]] });
    vias.push([tf.x + 10, FT]);
  }
}

type Group = { role: DeptRole | null; key: string; echelon: EchelonStage; status: EchelonStep['status'] }[];

function pipelineGroups(members: Employee[]) {
  const routes = [...new Map(members.flatMap(e => e.task ? [[e.task.id, e.task.echelons] as const] : [])).values()];
  const names = ECHELON_STAGES.filter(name => routes.some(route => route.stages.some(step => step.stage === name)));
  const groups: Group[] = names.map(name => {
    const steps = routes.flatMap(route => route.stages.filter(step => step.stage === name));
    const status = steps.every(step => step.status === 'skipped') ? 'skipped' : steps.some(step => step.status === 'active') ? 'active' : steps.every(step => ['complete', 'skipped'].includes(step.status)) ? 'complete' : 'pending';
    return [{ role: null, key: `stage:${name}`, echelon: name, status }];
  });
  return groups;
}

const ownsStage = (e: Employee): boolean => Boolean(e.task && e.task.echelons.resultKind === 'code' && e.task.echelons.ownerAgentId === e.id && e.task.echelons.phase === 'active');

/* Idle staff and observers stay outside the route; role metadata never assigns a workflow stage. */
function outsideFrames(known: ReadonlyMap<string, DeptRole>, members: Employee[], startX: number): Frame[] {
  const outside = members.filter(e => !ownsStage(e) || known.get(e.roleId ?? '')?.schema === 'observer');
  const keyOf = (e: Employee) => known.has(e.roleId ?? '') ? e.roleId! : '';
  const keys = [...new Set(outside.map(keyOf))];
  return keys.map((key, i) => {
    const role = known.get(key) ?? null;
    const x = startX + i * (FW + GS);
    const held = outside.filter(e => keyOf(e) === key);
    return { key: `outside:${key}`, role, x, h: FHEAD + Math.max(1, held.length) * PY + 8, stage: -1, members: placeMembers(held, x) };
  });
}

export function schemaLayout(d: Department, people: number): Schema {
  const head = d.employees.find(e => e.kind === 'head') ?? null;
  const { teamFrames, members, startX, teamEnd } = splitMembers(d);
  const known = new Map(d.roles.filter(r => members.some(e => e.roleId === r.id)).map(r => [r.id, r]));
  const groups = pipelineGroups(members);
  const observers = outsideFrames(known, members, startX);
  const lastObserver = observers[observers.length - 1];
  const outsideEnd = lastObserver ? lastObserver.x + FW : teamEnd;
  const pipelineStart = lastObserver ? outsideEnd + G : startX;

  const stages: Frame[][] = [];
  const ends: number[] = [];
  let x = pipelineStart;
  for (const [k, group] of groups.entries()) {
    const frames = group.map(g => {
      const held = members.filter(e => ownsStage(e) && e.task!.echelons.stage === g.echelon && known.get(e.roleId ?? '')?.schema !== 'observer');
      const frame: Frame = {
        key: g.key,
        role: g.role,
        echelon: g.echelon,
        status: g.status,
        x,
        h: FHEAD + Math.max(1, held.length) * PY + 8,
        stage: k,
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
  const hx = Math.max(outsideEnd + HW / 2, w / 2);

  const lines: Line[] = [];
  const vias: Point[] = [];
  addTeamLines(lines, vias, [...teamFrames, ...observers], hx);
  /* The head leads every stage frame: down to the bus, along it, and down each frame's spine to its chips. */
  if (stageFrames.length) {
    lines.push({ cls: 'tr', pts: [[hx, HH], [hx, BUS]] });
    lines.push({ cls: 'tr', pts: [[Math.min(hx, stageFrames[0]!.x + 10), BUS], [Math.max(hx, stageFrames[stageFrames.length - 1]!.x + 10), BUS]] });
    for (const f of stageFrames) {
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

  /* The report: from the last stage frame up and over into the head, or straight up when the head sits above it. */
  let report: Schema['report'] = null;
  const last = stageFrames[stageFrames.length - 1];
  if (head && last) {
    const ox = outX(last);
    const pts: Point[] = ox <= hx + HW / 2 ? [[ox, FT], [ox, HH]] : [[ox, FT], [ox, REP], [hx + HW / 2, REP]];
    report = { pts, label: pts.length === 3 ? [(ox + hx + HW / 2) / 2, REP] : [ox, (FT + HH) / 2] };
  }

  const peopleAt: Point[] = Array.from({ length: people }, (_, k) => [px, PEOPLE_Y + k * PEOPLE_STEP]);
  const right = Math.max(w, hx + HW / 2, people ? px + PW : 0);
  return { head, hx, w, h, right, frames, stages, lines, vias, report, people: peopleAt };
}

type Spot = { f: Frame; m: Placed };

function memberDown(s: Schema, at: Spot | null): Point[] | null {
  if (!at) return null;
  const sx = at.f.x + 10;
  if (at.f.stage < 0) {
    const y = HH / 2 - s.frames.filter(f => f.stage < 0).indexOf(at.f) * 20;
    return [[s.hx - HW / 2 + 14, y], [sx, y], [sx, at.m.cy], [at.m.x + 14, at.m.cy]];
  }
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

/* The arrowhead at the end of a line, as in the prototype. */
export function arrowD(pts: Point[]): string {
  const b = pts[pts.length - 1]!, a = pts[pts.length - 2]!;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len, s = 10, w = 5;
  const r = (v: number) => Math.round(v * 10) / 10;
  return `M ${b[0]} ${b[1]} L ${r(b[0] - ux * s - uy * w)} ${r(b[1] - uy * s + ux * w)} L ${r(b[0] - ux * s + uy * w)} ${r(b[1] - uy * s - ux * w)} Z`;
}
