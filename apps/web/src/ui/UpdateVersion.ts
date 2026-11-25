import { useEffect } from 'react';
import { service, type UpdateRun } from '../service-state';
import type { UpdateStep, UpdaterStatus } from '../types';
import type { Updates } from '../updates';
import { STEPS } from './UpdateProgress';
import { versionText } from './VersionMark';

/* A sent request keeps its selected build while the registry and the updater catch up. */
export function updateTargetText({ starting, target, view }: Updates): string {
  const build = starting ? target : view?.updater.status;
  return build ? versionText(build) : '';
}

export const versionedStatus = (status: UpdaterStatus) => ({ ...status, version: versionText(status) });

/* How far the update is, 0 to 1, as the step it reports tells; null where it reports none (it has not begun, or it is not
   known), so no bar is drawn. */
export function updateProgress(step: UpdateStep | null | undefined): number | null {
  if (!step) return null;
  const at = step === 'finished' ? STEPS.length : step === 'rollback' ? STEPS.length - 1 : STEPS.indexOf(step);
  return at < 0 ? null : at / STEPS.length;
}

/* How far an update has come while one is asked for or runs, for the service road; null while none does. */
export function updateRunOf({ view, starting }: Updates): UpdateRun | null {
  const status = view?.updater.status;
  if (!view || !(starting || status?.state === 'running')) return null;
  return { progress: starting ? null : updateProgress(status?.step) };
}

/* Tells the service road how far the update has come, and that it ended. */
export function useUpdateRoad(updates: Updates): void {
  const run = updateRunOf(updates);
  const runs = run !== null;
  const progress = run?.progress ?? null;
  useEffect(() => {
    service.setUpdate(runs ? { progress } : null);
  }, [runs, progress]);
  useEffect(() => () => service.setUpdate(null), []);
}
