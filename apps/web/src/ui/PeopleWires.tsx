import type { PeopleLayout } from '../map-people';
import type { WireGap } from '../map-people-bridges';
import { toD, type Point } from './wires';

const maskId = (prefix: string, personId: string) => `${prefix}-person-${personId}`;

export function peopleMask(placed: PeopleLayout, prefix: string, personId?: string): string | undefined {
  return placed.gaps.some(g => g.personId === personId) ? `url(#${maskId(prefix, personId!)})` : undefined;
}

function BridgeMask({ id, points, gaps }: { id: string; points: Point[]; gaps: WireGap[] }) {
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const x = Math.min(...xs) - 10, y = Math.min(...ys) - 10;
  const w = Math.max(...xs) - x + 10, h = Math.max(...ys) - y + 10;
  return (
    <mask id={id} maskUnits="userSpaceOnUse" x={x} y={y} width={w} height={h}>
      <rect x={x} y={y} width={w} height={h} fill="white" />
      {gaps.map((g, i) => <path key={i} d={toD(g.pts)} fill="none" stroke="black" strokeWidth="8" />)}
    </mask>
  );
}

/* The same bridge gaps apply to quiet traces, waiting decisions and message dots. */
export function PeopleBridgeMasks({ placed, prefix }: { placed: PeopleLayout; prefix: string }) {
  return (
    <defs>
      {[...new Set(placed.gaps.map(g => g.personId))].map(id => (
        <BridgeMask key={id} id={maskId(prefix, id)} points={placed.routes.filter(r => r.personId === id).flatMap(r => r.pts)} gaps={placed.gaps.filter(g => g.personId === id)} />
      ))}
    </defs>
  );
}
