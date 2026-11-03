import type { UpdaterStatus } from '../types';
import type { Updates } from '../updates';
import { versionText } from './VersionMark';

/* A sent request keeps its selected build while the registry and the updater catch up. */
export function updateTargetText({ starting, target, view }: Updates): string {
  const build = starting ? target : view?.updater.status;
  return build ? versionText(build) : '';
}

export const versionedStatus = (status: UpdaterStatus) => ({ ...status, version: versionText(status) });
