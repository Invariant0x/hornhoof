import { judgeLiveCheck, LIVE_CHECK_REFUSALS, type LiveCheckReason, type LiveCheckVerdict } from '@hornhoof/protocol/live-check';
import type { Ctx } from '../../app.js';
import type { Config } from '../../config.js';
import { ApiError, loggable } from '../../errors.js';
import { archOf, FULL_SHA, registry } from './registry.js';

/* install.sh says this as it is, so it holds nothing a shell would read. */
export const LIVE_CHECK_UNREAD = 'Could not read the live check of this build from the registry. Check the internet connection of the computer Hornhoof runs on, then try again.';

const refusedLiveCheck = (reason: LiveCheckReason): ApiError => new ApiError(409, 'conflict', LIVE_CHECK_REFUSALS[reason], `live_check_${reason}`);

export function requireYes(verdict: LiveCheckVerdict): void {
  if (!verdict.ok) throw refusedLiveCheck(verdict.reason);
}

/* A node goes to the build of its server, so a server gives its nodes only a build with its live check. Two servers are the
   exception. One CI did not build names no images: its nodes take the latest, which answers for itself. A live check stand runs
   its build in order to check it. */
export const needsNoProof = ({ commit, liveCheckStand }: Pick<Config, 'commit' | 'liveCheckStand'>): boolean => liveCheckStand || !FULL_SHA.test(commit);

/* The installer leaves a node as it is when this says no. */
export async function requireProvenBuild(ctx: Ctx): Promise<void> {
  if (needsNoProof(ctx.config)) return;
  const verdict = await ctx.updates.ownLiveCheck(ctx.config.commit).catch(err => {
    ctx.log.warn({ error: loggable(err) }, 'Could not read the live check of this build.');
    throw new ApiError(503, 'unavailable', LIVE_CHECK_UNREAD, 'registry_unreachable');
  });
  requireYes(verdict);
}

export type GateInput = { commit: string; tag?: string; proof?: unknown; image: string; base?: string };
export type GateVerdict = Exclude<LiveCheckVerdict, { ok: true }> | { ok: true; images: { app: string; node: string; updater: string } };

/* What the release workflow asks before it moves a tag every machine reads: all the images under that tag are those of this
   commit, and the live check speaks of exactly them. With proof, it judges a check not yet published. */
export async function liveCheckGate({ commit, tag, proof, image, base }: GateInput): Promise<GateVerdict> {
  const images = registry({ image, arch: archOf(), base });
  const build = await images.buildOf(tag ?? commit);
  if (!build) return { ok: false, reason: 'missing' };
  if (build.commit !== commit) return { ok: false, reason: 'foreign' };
  const siblings = await images.siblings(tag ?? commit);
  const verdict = judgeLiveCheck(proof === undefined ? await images.liveCheck(commit) : proof, { ...build, ...siblings });
  return verdict.ok ? { ok: true, images: { app: build.digest, node: siblings.node, updater: siblings.updater } } : verdict;
}
