/* The score a machine that may take the server is ranked by, the order it gives, the places pinned by hand, and the
   key of the line that says why a machine stands where it does. All of it pure: the ranking reads the rows and writes
   what these answer. */

export const ALWAYS_SHARE = 0.95;
const MOSTLY_SHARE = 0.75;
/* A machine younger than this is a newcomer, ranked after every established one. */
export const NEWCOMER_MS = 3 * 86_400_000;
/* A machine passes the one above it in its class only when it leads by more than this, so two close ones do not swap. */
const PASS_POINTS = 5;
/* A part under this share of its points is poor, and the line names it. */
const POOR_PART = 0.4;
const GIB = 2 ** 30;

/* What a machine measures. share: how much of the last week it was online, 0 to 1. */
export type Measured = {
  share: number | null;
  linkRttMs: number | null;
  linkMbps: number | null;
  internetRttMs: number | null;
  internetMbps: number | null;
  fsyncP99Ms: number | null;
  memory: number | null;
  cores: number | null;
};

/* Each part's points, not rounded: online of 40, link of 20, internet of 10, disk of 20, memory of 5, cores of 5. */
export type Parts = { online: number; link: number; internet: number; disk: number; memory: number; cores: number };
const FULL: Parts = { online: 40, link: 20, internet: 10, disk: 20, memory: 5, cores: 5 };

/* The share of full points between a value that earns nothing and one that earns everything, straight between. */
const between = (value: number, nothing: number, full: number): number => Math.min(1, Math.max(0, (value - nothing) / (full - nothing)));
const roundTrip = (ms: number | null): number => (ms === null ? 0 : between(ms, 300, 20));
const throughput = (mbps: number | null): number => (mbps === null ? 0 : between(mbps, 5, 100));

/* The share of the disk's points: a disk measured at 50 ms earns nothing, one at 2 ms everything, none measured nothing. */
const diskShare = (fsyncP99Ms: number | null): number => (fsyncP99Ms === null ? 0 : between(fsyncP99Ms, 50, 2));

export function scoreOf(m: Measured): { points: number; parts: Parts } {
  const parts: Parts = {
    online: 40 * Math.min(1, Math.max(0, m.share ?? 0)),
    /* How fast the leader sends to a machine is known only once it has sent it something: none yet scores half. */
    link: 10 * roundTrip(m.linkRttMs) + (m.linkMbps === null ? 5 : 10 * throughput(m.linkMbps)),
    internet: 5 * roundTrip(m.internetRttMs) + 5 * throughput(m.internetMbps),
    disk: 20 * diskShare(m.fsyncP99Ms),
    memory: m.memory === null ? 0 : 5 * between(m.memory / GIB, 4, 16),
    cores: m.cores === null ? 0 : 5 * Math.min(1, Math.max(0, m.cores / 8)),
  };
  return { points: Math.round(parts.online + parts.link + parts.internet + parts.disk + parts.memory + parts.cores), parts };
}

/* always: online 95% of the time or more, the class that stands first. */
export type Scored = { id: string; points: number; always: boolean };

/* Whether b may pass a, the one above it: from the class below into the 95% class, or within one class by more than
   the margin. */
export function passes(b: Scored, a: Scored): boolean {
  if (b.always !== a.always) return b.always;
  return b.points - a.points > PASS_POINTS;
}

/* Neighbours swap until no machine passes the one above it. Each swap puts a pair into the order of class and points,
   so it ends, with the 95% class on top. */
export function settle<T extends Scored>(order: T[]): T[] {
  const settled = [...order];
  for (let swapped = true; swapped; ) {
    swapped = false;
    for (let at = 1; at < settled.length; at++) {
      if (!passes(settled[at]!, settled[at - 1]!)) continue;
      [settled[at - 1], settled[at]] = [settled[at]!, settled[at - 1]!];
      swapped = true;
    }
  }
  return settled;
}

/* The places from 2 on, in order: index 0 is number 2. Each pin of a place there is takes it; the pins above the last
   place, in their order, take the last free places; the others fill what is free in the order they came in. */
export function placePins<T extends { id: string }>(free: T[], pinned: { item: T; pin: number }[]): T[] {
  const last = 1 + free.length + pinned.length;
  const places = new Map<number, T>();
  const byPin = [...pinned].sort((a, b) => a.pin - b.pin);
  for (const { item, pin } of byPin) if (pin <= last && !places.has(pin)) places.set(pin, item);
  const beyond = byPin.filter(({ item }) => ![...places.values()].includes(item));
  const open = (): number[] => Array.from({ length: last - 1 }, (_, at) => at + 2).filter(place => !places.has(place));
  beyond.forEach(({ item }, at) => places.set(open().slice(-(beyond.length - at))[0]!, item));
  const left = open();
  free.forEach((item, at) => places.set(left[at]!, item));
  return Array.from({ length: last - 1 }, (_, at) => places.get(at + 2)!);
}

/* Whether a machine's disk is poor, which the line says as slow_disk when it is its weakest part. */
export const diskPoor = (m: Pick<Measured, 'fsyncP99Ms'>): boolean => diskShare(m.fsyncP99Ms) < POOR_PART;

/* What the line compares a machine with: over the machines numbered from 2, the least memory and the best share of
   the link's points. */
export type WhyContext = { leastMemory: number | null; bestLink: number | null };

/* The key of the line: how often the machine is online, then its weakest part when one is poor, else its strongest. */
export function whyOf(m: Measured, c: WhyContext): string {
  const share = m.share ?? 0;
  const online = share >= ALWAYS_SHARE ? 'always' : share >= MOSTLY_SHARE ? 'mostly' : 'often_off';
  const { parts } = scoreOf(m);
  const of = (part: keyof Parts): number => parts[part] / FULL[part];
  const least = c.leastMemory !== null && m.memory !== null && m.memory <= c.leastMemory;
  const best = c.bestLink !== null && of('link') >= c.bestLink;
  const weak: [keyof Parts, string][] = [['link', 'slow_link'], ['internet', 'slow_internet'], ['disk', 'slow_disk'], ['memory', least ? 'small' : 'little'], ['cores', 'few_cores']];
  const strong: [keyof Parts, string][] = [['link', best ? 'best_link' : 'good_link'], ['disk', 'fast_disk'], ['internet', 'fast_internet'], ['memory', 'big'], ['cores', 'many_cores']];
  const weakest = weak.reduce((worst, one) => (of(one[0]) < of(worst[0]) ? one : worst));
  if (of(weakest[0]) < POOR_PART) return `${online}.${weakest[1]}`;
  return `${online}.${strong.reduce((top, one) => (of(one[0]) > of(top[0]) ? one : top))[1]}`;
}
