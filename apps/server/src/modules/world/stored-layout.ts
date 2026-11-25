/* What a company's world_layouts row may hold: the check PUT /api/world/layout saves a city with, and the relocations
   the server itself records. A merge writes such a row only when it passes the same check (#1967). */

import { WORLD_BUILDING_KINDS, WorldLayoutSaveSchema, WorldRelocationRequestSchema } from '@hornhoof/protocol/world';
import { z } from 'zod';

/* The largest city a person's browser may save: the request it comes in is at most this. */
export const WORLD_LAYOUT_BYTES = 1024 * 1024;
export const MAX_STORED_RELOCATIONS = 200;

const request = WorldRelocationRequestSchema.shape;
const StoredRelocation = z.object({
  id: z.string().min(1).max(80),
  buildingId: request.buildingId,
  buildingKind: z.enum(WORLD_BUILDING_KINDS),
  buildingLabel: request.buildingLabel,
  fromCol: request.fromCol,
  fromRow: request.fromRow,
  toCol: request.toCol,
  toRow: request.toRow,
  taskId: z.uuid(),
  taskNumber: z.number().int().positive(),
  assigneeAgentId: z.uuid(),
  departmentId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

/* The row as the database gives it, by its column names. A layout is null until the browser saves one: a relocation
   records the row first. */
const StoredLayout = z.object({
  pack_id: WorldLayoutSaveSchema.shape.packId,
  seed: WorldLayoutSaveSchema.shape.seed,
  layout: WorldLayoutSaveSchema.shape.layout.nullable(),
  relocations: z.array(StoredRelocation).max(MAX_STORED_RELOCATIONS),
});

/* Why a world_layouts row is not one the app would save, or null when it is. */
export function storedLayoutProblem(row: Readonly<Record<string, unknown>>): string | null {
  const parsed = StoredLayout.safeParse(row);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    return `Its city is not one the app saves: ${issue?.path.join('.') || 'the row'} is not valid.`;
  }
  if (row.layout !== null && Buffer.byteLength(JSON.stringify(row.layout)) > WORLD_LAYOUT_BYTES) return 'Its city is larger than the app saves one.';
  return null;
}
