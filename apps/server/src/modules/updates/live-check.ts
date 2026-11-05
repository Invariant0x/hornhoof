import { judgeLiveCheck, LIVE_CHECK_REFUSALS, type LiveCheckReason, type LiveCheckVerdict } from '@hornhoof/protocol/live-check';
import type { Ctx } from '../../app.js';
import { ApiError, loggable } from '../../errors.js';
import { archOf, FULL_SHA, registry } from './registry.js';

export const refusedLiveCheck = (reason: LiveCheckReason): ApiError => new ApiError(409, 'conflict', LIVE_CHECK_REFUSALS[reason], `live_check_${reason}`);

/* A node goes to the build of its server, so a server gives its nodes only a build with its live check. The installer leaves
   a node as it is when this says no. A server CI did not build names no images: its nodes take the latest, which CI released
   only with its check. */
export async function requireProvenBuild(ctx: Ctx): Promise<void> {
  const { commit } = ctx.config;
  if (!FULL_SHA.test(commit)) return;
  const verdict = await ctx.updates.ownLiveCheck(commit).catch(err => {
    ctx.log.warn({ error: loggable(err) }, 'Could not read the live check of this build.');
    throw new ApiError(503, 'unavailable', 'Could not read the live check of this build from the registry. Check the internet connection, then try again.', 'registry_unreachable');
  });
  if (!verdict.ok) throw refusedLiveCheck(verdict.reason);
}

export type GateInput = { commit: string; tag?: string; proof?: unknown; image: string; base?: string };

/* What the release workflow asks before it moves a tag every machine reads: the images under that tag are those of this
   commit, and the live check speaks of exactly them. With proof, it judges a check not yet published. */
export async function liveCheckGate({ commit, tag, proof, image, base }: GateInput): Promise<LiveCheckVerdict> {
  const images = registry({ image, arch: archOf(), base });
  const build = await images.buildOf(tag ?? commit);
  if (!build) return { ok: false, reason: 'missing' };
  if (build.commit !== commit) return { ok: false, reason: 'foreign' };
  return judgeLiveCheck(proof === undefined ? await images.liveCheck(commit) : proof, { ...build, ...await images.siblings(commit) });
}
