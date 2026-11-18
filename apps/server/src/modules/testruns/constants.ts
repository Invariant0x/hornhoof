
/* The free memory a part of work needs unless its agent says. */
export const WORK_MEMORY_GB = 2;
/* The time a run gets by default, and at most. */
export const TEST_MINUTES = 30;
export const TEST_MINUTES_MAX = 120;
/* Quiet time for a test part with no recorded times for its files. */
export const UNMEASURED_QUIET_MS = 60 * 60_000;
/* Runs of one agent that may go on at once. */
export const OPEN_RUNS = 3;
/* A part that found no free machine this long ends, so its agent hears of it instead of waiting on. */
export const WAIT_MS = 2 * 3_600_000;
/* A part whose machine is away this long runs again on another, and a part runs again at most this many times. */
export const AWAY_MS = 3 * 60_000;
export const RERUNS = 2;
