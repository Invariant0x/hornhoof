import { z } from 'zod';

/* A release reaches machines only with the proof that a real node of this exact build ran each of these programs: it got
   its words, wrote them down, answered and ended its turn the usual way. The proof lives next to the images it speaks of,
   under a tag of its own, and whoever may publish images is who may publish it. */
export const LIVE_CHECK_PROGRAMS = ['claude', 'codex', 'kimi', 'antigravity'] as const;
export const LIVE_CHECK_LABEL = 'io.hornhoof.live-check';
export const liveCheckTag = (commit: string): string => `live-check-${commit}`;

const Program = z.enum(LIVE_CHECK_PROGRAMS);
const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const Clock = z.iso.datetime();
const Fact = z.string().min(1).max(200);

const Passed = z.object({
  program: Program, outcome: z.literal('passed'), version: Fact, machine: Fact, node: z.uuid(), session: Fact, job: z.uuid(), instance: z.uuid(),
  /* How many programs of this agent the check started: a second one means the words went to two. */
  generations: z.literal(1),
  asked: Clock, recorded: Clock, answered: Clock, finished: Clock,
}).strict();
const NotPassed = z.object({ program: Program, outcome: z.enum(['failed', 'not_run']), why: z.string().min(1).max(500) }).strict();
type PassedRun = z.infer<typeof Passed>;

export const LiveCheckProof = z.object({
  schema: z.literal(1), commit: z.string().regex(/^[0-9a-f]{40}$/), version: Fact,
  images: z.object({ app: Digest, node: Digest, updater: Digest }).strict(),
  checkedAt: Clock,
  /* The digest of the cleaned evidence kept with the release's task: what a person reads to believe this. */
  evidence: Digest,
  programs: z.array(z.discriminatedUnion('outcome', [Passed, NotPassed])).max(LIVE_CHECK_PROGRAMS.length),
}).strict();
export type LiveCheckProof = z.infer<typeof LiveCheckProof>;

/* The build as the registry shows it: an image it lacks has an empty digest. */
export type LiveCheckBuild = { commit: string; version: string; digest: string; node: string; updater: string; created: string };
export type LiveCheckReason = 'missing' | 'invalid' | 'foreign' | 'partial' | 'stale';
export type LiveCheckVerdict = { ok: true } | { ok: false; reason: LiveCheckReason };

export const LIVE_CHECK_REFUSALS: Record<LiveCheckReason, string> = {
  missing: 'This build has no live check of Claude, Codex, Kimi and Antigravity.',
  invalid: 'The live check of this build cannot be read as one.',
  foreign: 'The live check speaks of another build than this one.',
  partial: 'The live check of this build did not pass all of Claude, Codex, Kimi and Antigravity.',
  stale: 'The live check of this build is older than its images.',
};

/* Clocks of two machines differ a little; a proof further ahead than this comes from no run that happened. */
const CLOCKS_DIFFER_MS = 5 * 60_000;
const refused = (reason: LiveCheckReason): LiveCheckVerdict => ({ ok: false, reason });
const isPassed = (run: LiveCheckProof['programs'][number]): run is PassedRun => run.outcome === 'passed';

function inOrder(run: PassedRun, end: string): boolean {
  const clocks = [run.asked, run.recorded, run.answered, run.finished, end].map(at => Date.parse(at));
  return clocks.every((at, n) => n === 0 || clocks[n - 1]! <= at);
}

function sameBuild(proof: LiveCheckProof, build: LiveCheckBuild): boolean {
  return proof.commit === build.commit && proof.version === build.version && proof.images.app === build.digest && proof.images.node === build.node && proof.images.updater === build.updater;
}

/* Fails closed: anything but a proof of these exact images with all four programs passed since they were made is a no. */
export function judgeLiveCheck(raw: unknown, build: LiveCheckBuild, now = new Date()): LiveCheckVerdict {
  if (raw === null || raw === undefined) return refused('missing');
  const parsed = LiveCheckProof.safeParse(raw);
  if (!parsed.success) return refused('invalid');
  const proof = parsed.data, passed = proof.programs.filter(isPassed);
  if (!passed.every(run => inOrder(run, proof.checkedAt)) || Date.parse(proof.checkedAt) > +now + CLOCKS_DIFFER_MS) return refused('invalid');
  if (!sameBuild(proof, build)) return refused('foreign');
  if (!LIVE_CHECK_PROGRAMS.every(program => passed.some(run => run.program === program))) return refused('partial');
  const made = Date.parse(build.created);
  return passed.every(run => made <= Date.parse(run.asked)) ? { ok: true } : refused('stale');
}
