/* The disk area each machine gives the company's files: 10 GiB unless its owner set another, none once set to 0. */
export const DEFAULT_AREA_BYTES = 10 * 1024 ** 3;

/* What a machine's setting gives it: its own number, or the default where it set none. */
export const areaOf = (limit: number | null | undefined): number => limit ?? DEFAULT_AREA_BYTES;

/* The free disk a machine keeps whatever its area: a tenth of the disk its files lie on, at most 2 GiB, and 2 GiB where
   that disk is not known. No file is placed on one that would be left with less. */
export const FLOOR_BYTES = 2 * 1024 ** 3;
export const floorOf = (total: number | null | undefined): number => (total == null ? FLOOR_BYTES : Math.min(FLOOR_BYTES, Math.floor(total / 10)));

/* What more a machine can be picked for: what its area holds past what its files take there and what it is still to
   fetch, and no more than its disk keeps above the floor once those come. A disk it has not said bounds nothing but the
   area. */
export function headroomOf(seat: { area: number; used: number; pending: number; free: number | null; total: number | null }): number {
  const area = seat.area - seat.used - seat.pending;
  const disk = seat.free === null ? Infinity : seat.free - floorOf(seat.total) - seat.pending;
  return Math.max(0, Math.min(area, disk));
}
