import { describe, expect, it } from 'vitest';
import { DiskCleaned, DiskLow, diskSettings, diskThreshold, DISK_SETTINGS } from '../src/disk/state.js';

const GIB = 1024 ** 3;
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 20, 12, minutes));

describe('the free space a node needs for heavy work', () => {
  it('is a share of the disk, and never less than the amount', () => {
    const settings = { share: 0.1, amount: 20 * GIB };
    expect(diskThreshold(1000 * GIB, settings)).toBe(100 * GIB);
    expect(diskThreshold(64 * GIB, settings)).toBe(20 * GIB);
  });

  it('is in whole bytes', () => {
    expect(Number.isInteger(diskThreshold(1001, { share: 0.1, amount: 0 }))).toBe(true);
  });

  it('comes from the share in percent and the amount in GiB the machine owner set, else the defaults', () => {
    expect(diskSettings({})).toEqual(DISK_SETTINGS);
    expect(diskSettings({ HORNHOOF_DISK_SHARE: '5', HORNHOOF_DISK_GB: '8' })).toEqual({ share: 0.05, amount: 8 * GIB });
    for (const bad of ['', '-1', '1.5', '91', 'ten', '1e3']) expect(diskSettings({ HORNHOOF_DISK_SHARE: bad }).share).toBe(DISK_SETTINGS.share);
    for (const bad of ['', '-2', '0.5', '4097', 'many']) expect(diskSettings({ HORNHOOF_DISK_GB: bad }).amount).toBe(DISK_SETTINGS.amount);
    expect(diskSettings({ HORNHOOF_DISK_SHARE: '0', HORNHOOF_DISK_GB: '0' })).toEqual({ share: 0, amount: 0 });
  });
});

describe('a node low on disk', () => {
  it('has room while every disk has its threshold free after cleaning', () => {
    const low = new DiskLow();
    expect(low.after([{ free: 30 * GIB, threshold: 20 * GIB }], at(0))).toBeNull();
    expect(low.now).toBeNull();
  });

  it('is low from the cleaning after which a disk is still under its threshold, and stays low since then', () => {
    const low = new DiskLow();
    expect(low.after([{ free: 30 * GIB, threshold: 20 * GIB }, { free: 5 * GIB, threshold: 20 * GIB }], at(1))).toEqual({ since: at(1).toISOString() });
    expect(low.after([{ free: 30 * GIB, threshold: 20 * GIB }, { free: 4 * GIB, threshold: 20 * GIB }], at(11))).toEqual({ since: at(1).toISOString() });
    expect(low.now).toEqual({ since: at(1).toISOString() });
  });

  it('gets its room back only with a tenth of the threshold to spare, so it does not flicker at the line', () => {
    const low = new DiskLow();
    low.after([{ free: 19 * GIB, threshold: 20 * GIB }], at(0));
    expect(low.after([{ free: 21 * GIB, threshold: 20 * GIB }], at(10))).toEqual({ since: at(0).toISOString() });
    expect(low.after([{ free: 22 * GIB, threshold: 20 * GIB }], at(20))).toBeNull();
    expect(low.after([{ free: 21 * GIB, threshold: 20 * GIB }], at(30))).toBeNull();
  });

  it('is low again from a new time once it had its room back', () => {
    const low = new DiskLow();
    low.after([{ free: 1 * GIB, threshold: 20 * GIB }], at(0));
    low.after([{ free: 40 * GIB, threshold: 20 * GIB }], at(10));
    expect(low.after([{ free: 1 * GIB, threshold: 20 * GIB }], at(20))).toEqual({ since: at(20).toISOString() });
  });

  it('is never low on a disk it could not measure', () => {
    expect(new DiskLow().after([], at(0))).toBeNull();
  });
});

describe('what a node says it removed', () => {
  it('is one entry for each part of each cleaning, newest first, and nothing for a part that freed nothing', () => {
    const cleaned = new DiskCleaned();
    cleaned.add([{ part: 'checkTemp', bytes: 3 }, { part: 'workingCopies', bytes: 10 }, { part: 'checkTemp', bytes: 4 }, { part: 'recordings', bytes: 0 }], at(0));
    cleaned.add([{ part: 'images', bytes: 5 * GIB }], at(10));
    expect(cleaned.list(at(10))).toEqual([
      { part: 'images', bytes: 5 * GIB, at: at(10).toISOString() },
      { part: 'checkTemp', bytes: 7, at: at(0).toISOString() },
      { part: 'workingCopies', bytes: 10, at: at(0).toISOString() },
    ]);
  });

  it('covers the last 24 hours only', () => {
    const cleaned = new DiskCleaned();
    cleaned.add([{ part: 'checkTemp', bytes: 1 }], at(0));
    cleaned.add([{ part: 'recordings', bytes: 2 }], at(60));
    const nextDay = new Date(at(0).getTime() + 24 * 60 * 60 * 1000 + 1);
    expect(cleaned.list(nextDay)).toEqual([{ part: 'recordings', bytes: 2, at: at(60).toISOString() }]);
  });

  it('names at most the 50 newest', () => {
    const cleaned = new DiskCleaned();
    for (let i = 0; i < 60; i++) cleaned.add([{ part: 'checkTemp', bytes: i + 1 }], new Date(at(0).getTime() + i * 1000));
    const listed = cleaned.list(at(5));
    expect(listed).toHaveLength(50);
    expect(listed[0]!.bytes).toBe(60);
    expect(listed[49]!.bytes).toBe(11);
  });
});
