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

/* The running build over the map only (#1590, #1874): small muted HUD text in the bottom end corner of the room its bars
   leave free, read left to right on any page, with no full-width bottom bar anywhere in the app. off: a department's view
   is open over the map, which names no version then. */
export function MapVersion({ off = false }: { off?: boolean }) {
  return off ? null : <MapVersionText />;
}

function MapVersionText() {
  const version = useVersion();
  return <p className="map-version">{version && <bdi dir="ltr">{versionText(version)}</bdi>}</p>;
}
