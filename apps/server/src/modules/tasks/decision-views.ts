import type { DecidedBy } from '../../auth/decisions.js';
import { deptName } from '../departments/templates.js';
import type { departmentNames } from './decisions.js';

/* Whom people read a decision is for, with the department's name. */
export function decidedByView(d: DecidedBy, places: Awaited<ReturnType<typeof departmentNames>>): { kind: DecidedBy['kind']; department: { id: string; name: string } | null } {
  const place = d.departmentId ? places.get(d.departmentId) : undefined;
  return { kind: d.kind, department: place ? { id: place.id, name: deptName(place) } : null };
}
