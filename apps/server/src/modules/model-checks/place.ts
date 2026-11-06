import type { ModelCheckKind } from '@hornhoof/protocol';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { modelChecks } from '../../db/schema.js';

export type CheckPlace = { companyId: string; departmentId: string; productId: string | null; kind: ModelCheckKind };

export function sameCheckPlace(place: CheckPlace): SQL | undefined {
  return and(
    eq(modelChecks.companyId, place.companyId),
    eq(modelChecks.departmentId, place.departmentId),
    place.productId ? eq(modelChecks.productId, place.productId) : isNull(modelChecks.productId),
    eq(modelChecks.kind, place.kind),
  );
}
