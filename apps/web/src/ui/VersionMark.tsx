import { useEffect, useState } from 'react';
import { api } from '../api';

export type Version = { version: string; commit?: string };
type VersionState = { version: Version | null; failed: boolean };

/* One source for loading the running build, including the smaller authenticated About response. */
export function useVersionState(path: string): VersionState {
  const [state, setState] = useState<VersionState>({ version: null, failed: false });
  useEffect(() => {
    let live = true;
    api.get<Version>(path).then(
      version => live && setState({ version, failed: false }),
      () => live && setState({ version: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [path]);
  return state;
}

/* The running build, asked once; null until it answers or when it cannot. */
export function useVersion(): Version | null {
  return useVersionState('/api/version').version;
}

const shortCommit = (commit?: string) => commit?.slice(0, 7) || '?';
export const versionText = ({ version, commit }: Version) => `${version} (${shortCommit(commit)})`;
export const buildText = (build: Version & { tag: string }) => versionText({ version: build.version || build.tag, commit: build.commit });

/* The running build has a footer below the screen, in a row of its own so it covers nothing; the map names it over its own
   corner instead. */
export function VersionMark() {
  const version = useVersion();
  return version && <footer className="version-mark">{versionText(version)}</footer>;
}

/* The running build over the map, in the bottom end corner of the room its bars leave free. It stands on the map from the
   moment the map opens, even before the build answers, so the footer row never comes and goes under the map (#1590). */
export function MapVersion() {
  const version = useVersion();
  return <p className="map-version">{version && versionText(version)}</p>;
}
