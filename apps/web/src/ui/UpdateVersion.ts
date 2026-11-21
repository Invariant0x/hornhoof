import type { Language } from '../i18n';
import type { UpdaterStatus } from '../types';
import type { Updates } from '../updates';
import { clock } from './subscription';
import { versionText } from './VersionMark';

/* A sent request keeps its selected build while the registry and the updater catch up. */
export function updateTargetText({ starting, target, view }: Updates): string {
  const build = starting ? target : view?.updater.status;
  return build ? versionText(build) : '';
}

export const versionedStatus = (status: UpdaterStatus) => ({ ...status, version: versionText(status) });

/* Formats the last updater heartbeat timestamp in the active language, or empty string if unparseable. */
export function silentTime(language: Language, since: string): string {
  return Number.isNaN(Date.parse(since)) ? '' : (clock(language, since) ?? '');
}
