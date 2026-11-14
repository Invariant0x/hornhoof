import { describe, expect, it } from 'vitest';
import { DAY_MS, RoundTrips } from '../src/modules/keeper/round-trips.js';

describe('the round trips of a day', () => {
  it("takes the day's median", () => {
    const trips = new RoundTrips();
    expect(trips.median(0)).toBeNull();
    trips.add(10, 0);
    trips.add(30, 20_000);
    trips.add(20, 40_000);
    expect(trips.median(40_000)).toBe(20);
    /* A sample that comes sooner than a third of a minute after the one before is not kept. */
    trips.add(900, 45_000);
    expect(trips.median(45_000)).toBe(20);
    /* An even count gives the middle of the two in the middle, as a whole number. */
    trips.add(25, 60_000);
    expect(trips.median(60_000)).toBe(23);
    /* After a day and a minute the first sample is no part of the day any more. */
    expect(trips.median(DAY_MS + 60_000)).toBe(25);
    expect(trips.median(2 * DAY_MS + 60_000)).toBeNull();
  });

  it('keeps by the paces it is given', () => {
    const trips = new RoundTrips({ keepMs: 1000, everyMs: 100 });
    trips.add(5, 0);
    trips.add(7, 50);
    trips.add(9, 100);
    expect(trips.median(100)).toBe(7);
    expect(trips.median(1050)).toBe(9);
  });
});
