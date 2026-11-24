/* The disk area each machine gives the company's files: 10 GiB unless its owner set another, none once set to 0. */
export const DEFAULT_AREA_BYTES = 10 * 1024 ** 3;

/* What a machine's setting gives it: its own number, or the default where it set none. */
export const areaOf = (limit: number | null | undefined): number => limit ?? DEFAULT_AREA_BYTES;

/* The free disk a machine keeps whatever its area: no file is placed on one that would be left with less. */
export const FLOOR_BYTES = 2 * 1024 ** 3;
