import { isStaged, type EchelonStage } from '@hornhoof/protocol/echelons';
import type { Department, DeptRole, Employee, Team } from '../types';
import { grownTo } from '../ui/natural-height';
import type { Point } from '../ui/wires';

/* A department's schema in world pixels. From the top: the head with the people who reach the
   department at its right, the bus from the head to every frame, the pipeline between stages with a numbered gate before each
   check, then a frame per role. Work goes left to right: design, ordinary work, each check in order, then the final check.
   Only sub-units and observers stand apart from the pipeline. */
export const FW = 280, GS = 44, G = 150, CW = 240, CH = 84, PY = 96, HW = 380, HH = 184, PW = 220, PH = 56;
export const BUS = HH + 44, RY = BUS + 44, CY = BUS + 84, FT = CY + 50, FHEAD = 100, REP = 92;
const PEOPLE_Y = 12, PEOPLE_STEP = 66;
/* Under a role's heading, 12 to its first chip, as between its chips, and 1 for the frame's line above the heading. */
const HEADING_ROOM = 13;

/* How tall the words of the schema need its boxes to be, as the screen measured them: the head card, the tallest chip and
   the tallest heading of a role. */
export type WordsNeed = { head: number; chip: number; heading: number };
/* The heights the schema stands on: the head card, every chip and every role's heading, the step from one chip to the next,
   and the levels of the bus, the pipeline's gates, the pipeline and the frames' tops under the head. With words that fit,
   the constants above. */
export type Size = { head: number; chip: number; heading: number; row: number; bus: number; ry: number; cy: number; ft: number };

export function schemaSize(need: Partial<WordsNeed> = {}): Size {
  const head = grownTo(HH, need.head ?? 0), chip = grownTo(CH, need.chip ?? 0), heading = grownTo(FHEAD, (need.heading ?? 0) + HEADING_ROOM);
  const bus = head + BUS - HH;
  return { head, chip, heading, row: chip + PY - CH, bus, ry: bus + RY - BUS, cy: bus + CY - BUS, ft: bus + FT - BUS };
}

export type Placed = { e: Employee; x: number; y: number; cy: number };
/* key: the role's id, 'team:<id>' for a sub-unit frame, or '' for the frame of employees whose role the department does not know. */
/* check: the frame stands behind a gate, as every check after the ordinary work does. */
export type Frame = { key: string; role: DeptRole | null; team?: Team | null; oneShot?: OneShotStage; x: number; h: number; stage: number; check?: boolean; members: Placed[] };
/* tr: the bus from the head; tick: from a spine to a chip; pl: the pipeline and the report; gate: between stages. */
export type Line = { cls: 'tr' | 'tick' | 'pl' | 'gate'; pts: Point[]; arrow?: boolean };

export type Schema = {
  size: Size;
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

const placeMembers = (z: Size, held: Employee[], x: number): Placed[] =>
  held.map((e, i) => ({ e, x: x + 20, y: z.ft + z.heading + i * z.row, cy: z.ft + z.heading + i * z.row + z.chip / 2 }));

/* A frame holds its heading and a row per chip, one at least, and 8 under the last. */
const frameHeight = (z: Size, chips: number) => z.heading + Math.max(1, chips) * z.row + 8;

/* Each sub-unit gets its own frame at the left, outside the pipeline stages. */
function splitMembers(d: Department, z: Size) {
  const all = d.employees.filter(e => e.kind !== 'head');
  const teamIds = new Set(d.teams.map(t => t.id));
  const teamFrames: Frame[] = d.teams.map((team, i) => {
    const held = all.filter(e => e.teamId === team.id);
    const x = i * (FW + GS);
    return { key: `team:${team.id}`, role: null, team, x, h: frameHeight(z, held.length), stage: -1, members: placeMembers(z, held, x) };
  });
  const last = teamFrames[teamFrames.length - 1];
  const teamEnd = last ? last.x + FW : 0;
  return { teamFrames, members: all.filter(e => !e.teamId || !teamIds.has(e.teamId)), startX: last ? teamEnd + G : 0, teamEnd };
}

/* A one-shot stage of the department's route: its calls start from zero each time and show as diamonds in its frame. */
export type OneShotStage = { stage: EchelonStage; fanOut: number; judge: boolean; ownerRole?: string; gate?: number | null };

/* The one-shot stages of the department's default route, or of its first route when none is the default, in route order. */
export function oneShotStagesOf(d: Department): OneShotStage[] {
  const routes = (d.pipelines ?? []).filter(p => !p.archived);
  const route = routes.find(p => p.isDefault) ?? routes[0];
  const seen = new Set<EchelonStage>();
  return (route?.stages ?? []).flatMap(s => {
    if (!s.oneShot || !s.echelon || seen.has(s.echelon)) return [];
    seen.add(s.echelon);
    const gate = s.ownerRole ? d.roles.find(r => r.id === s.ownerRole)?.gate : undefined;
    return [{ stage: s.echelon, fanOut: s.oneShot.fanOut, judge: s.oneShot.judge, ...(s.ownerRole ? { ownerRole: s.ownerRole } : {}), ...(gate !== undefined ? { gate } : {}) }];
  });
}

type Group = { role: DeptRole | null; key: string; oneShot?: OneShotStage }[];

/* Role metadata decides the pipeline, in the order of the development stages: design, ordinary work, each check in its order,
   then the final check. Every check after the work is a numbered gate the work passes in turn. */
function pipelineGroups(known: ReadonlyMap<string, DeptRole>, loose: Employee[], oneShots: OneShotStage[]) {
  const roles = [...known.values()].filter(r => r.schema !== 'observer');
  const entries = roles.map(role => ({ key: role.id, role, gate: role.gate, schema: role.schema }));
  const lastGate = Math.max(0, ...roles.map(r => r.gate ?? 0), ...oneShots.map(s => s.gate ?? 0));
  const calls = oneShots.map((oneShot, i) => {
    const owner = roles.find(r => r.id === oneShot.ownerRole);
    const early = oneShot.stage === 'architecture' || oneShot.stage === 'development';
    const gate = oneShot.gate === undefined ? (early ? null : lastGate + i + 1) : oneShot.gate;
    return { key: `one-shot:${oneShot.stage}`, role: null, oneShot, gate, schema: owner?.schema ?? (oneShot.stage === 'architecture' ? 'before_work' : null) };
  });
  const frames = [...entries, ...calls];
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

/* A 280 px frame with heading padding holds thirteen 14 px marks with 3 px gaps. */
const callFrameHeight = (z: Size, { fanOut, judge }: OneShotStage) => z.heading + Math.ceil((fanOut + Number(judge)) / 13) * 17;

/* Whoever leads a stage of a task now: it stays in its role's frame and is marked there. */
export const leadsStage = (e: Employee): boolean => Boolean(e.task && isStaged(e.task.echelons.resultKind) && e.task.echelons.ownerAgentId === e.id && e.task.echelons.phase === 'active');

/* Observers sit beside the pipeline, like sub-unit frames, and hang on the head's bus as every frame does. */
function observerFrames(z: Size, known: ReadonlyMap<string, DeptRole>, members: Employee[], startX: number): Frame[] {
  return [...known.values()].filter(r => r.schema === 'observer').map((role, i) => {
    const x = startX + i * (FW + GS);
    const held = members.filter(e => e.roleId === role.id);
    return { key: role.id, role, x, h: frameHeight(z, held.length), stage: -1, members: placeMembers(z, held, x) };
  });
}

/* need: how tall the words of the head card, the chips and the headings need them; without it, the sizes they always had. */
export function schemaLayout(d: Department, people: number, need: Partial<WordsNeed> = {}): Schema {
  const z = schemaSize(need);
  const head = d.employees.find(e => e.kind === 'head') ?? null;
  const { teamFrames, members, startX, teamEnd } = splitMembers(d, z);
  const known = new Map(d.roles.filter(r => members.some(e => e.roleId === r.id)).map(r => [r.id, r]));
  const loose = members.filter(e => !e.roleId || !known.has(e.roleId));
  const { groups, firstCheck } = pipelineGroups(known, loose, oneShotStagesOf(d));
  const observers = observerFrames(z, known, members, startX);
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
      const held = g.oneShot ? [] : g.role ? members.filter(e => e.roleId === g.role!.id) : loose;
      const frame: Frame = {
        key: g.key,
        role: g.role,
        oneShot: g.oneShot,
        x,
        h: g.oneShot ? callFrameHeight(z, g.oneShot) : frameHeight(z, held.length),
        stage: k,
        check: k >= firstCheck,
        members: placeMembers(z, held, x),
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
  const h = z.ft + Math.max(0, ...frames.map(f => f.h));
  /* Over the middle of all the frames, sub-units and observers included; a narrow department keeps the head whole. */
  const hx = Math.max(HW / 2, w / 2);

  const lines: Line[] = [];
  const vias: Point[] = [];
  /* Between stages, a dotted divider; on the pipeline, a numbered diamond before every check. */
  const gates: Schema['gates'] = [];
  for (let k = 1; k < stages.length; k++) {
    const sx = (ends[k - 1]! + starts[k]!) / 2;
    lines.push({ cls: 'gate', pts: [[sx, z.ry + 16], [sx, h]] });
    if (k >= firstCheck) gates.push({ x: sx, n: gates.length + 1 });
  }
  /* The head leads every frame, a sub-unit's and an observer's too: down to the bus, along it, and down each frame's spine
     to its chips. */
  if (frames.length) {
    lines.push({ cls: 'tr', pts: [[hx, z.head], [hx, z.bus]] });
    lines.push({ cls: 'tr', pts: [[Math.min(hx, frames[0]!.x + 10), z.bus], [Math.max(hx, frames[frames.length - 1]!.x + 10), z.bus]] });
    for (const f of frames) {
      const end = f.members.length ? f.members[f.members.length - 1]!.cy : z.ft + 40;
      lines.push({ cls: 'tr', pts: [[f.x + 10, z.bus], [f.x + 10, end]] });
      for (const m of f.members) lines.push({ cls: 'tick', pts: [[f.x + 10, m.cy], [m.x, m.cy]] });
      vias.push([f.x + 10, z.bus]);
    }
    vias.push([hx, z.bus]);
  }

  const px = hx + HW / 2 + 40;
  if (people) {
    lines.push({ cls: 'tr', pts: [[hx + HW / 2, 40], [px - 14, 40], [px - 14, 40 + (people - 1) * PEOPLE_STEP]] });
    for (let k = 0; k < people; k++) lines.push({ cls: 'tick', pts: [[px - 14, 40 + k * PEOPLE_STEP], [px, 40 + k * PEOPLE_STEP]] });
  }

  /* The pipeline: each stage's outputs meet on one line and go down into the next stage's inputs. */
  for (let k = 0; k < stages.length - 1; k++) {
    const a = stages[k]!, b = stages[k + 1]!;
    for (const f of a) lines.push({ cls: 'pl', pts: [[outX(f), z.ft], [outX(f), z.cy]] });
    lines.push({ cls: 'pl', pts: [[Math.min(...a.map(outX)), z.cy], [Math.max(...b.map(inX)), z.cy]] });
    for (const f of b) lines.push({ cls: 'pl', pts: [[inX(f), z.cy], [inX(f), z.ft]], arrow: true });
  }

  /* The report: from the last stage frame up and over into the head, or straight up when the head sits above it. Over, it
     comes into the head's right edge under the last person's chip there, or under the head when the chips reach below it. */
  let report: Schema['report'] = null;
  const last = stageFrames[stageFrames.length - 1];
  if (head && last) {
    const ox = outX(last), edge = hx + HW / 2;
    const ry = REP + Math.max(0, people - 1) * PEOPLE_STEP, under = (z.head + z.bus) / 2;
    if (ox <= edge) report = { pts: [[ox, z.ft], [ox, z.head]], label: [ox, (z.ft + z.head) / 2] };
    else if (ry < z.head) report = { pts: [[ox, z.ft], [ox, ry], [edge, ry]], label: [(ox + edge) / 2, ry] };
    else report = { pts: [[ox, z.ft], [ox, under], [edge - 30, under], [edge - 30, z.head]], label: [ox, (z.ft + under) / 2] };
  }

  const peopleAt: Point[] = Array.from({ length: people }, (_, k) => [px, PEOPLE_Y + k * PEOPLE_STEP]);
  const right = Math.max(w, hx + HW / 2, people ? px + PW : 0);
  return { size: z, head, hx, w, h, right, frames, stages, lines, vias, gates, report, people: peopleAt };
}

type Spot = { f: Frame; m: Placed };

/* From the head down to the bus, along it to the frame's spine and down that to the employee, in any frame. */
function memberDown(s: Schema, at: Spot | null): Point[] | null {
  if (!at) return null;
  const sx = at.f.x + 10, { head, bus } = s.size;
  return [[s.hx, head - 30], [s.hx, bus], [sx, bus], [sx, at.m.cy], [at.m.x + 14, at.m.cy]];
}

function memberOnward(s: Schema, at: Spot | null): Point[] | null {
  if (!at) return null;
  if (at.f.stage < 0) return [...memberDown(s, at)!].reverse();
  const next = s.stages[at.f.stage + 1];
  const { ft, cy } = s.size;
  if (next) return [[outX(at.f), ft], [outX(at.f), cy], [inX(next[0]!), cy], [inX(next[0]!), ft]];
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
