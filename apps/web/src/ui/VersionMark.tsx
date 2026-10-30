import { useEffect, useState } from 'react';
import { api } from '../api';

export type Version = { version: string; commit: string };

/* The running build, asked once; null until it answers or when it cannot. */
export function useVersion(): Version | null {
  const [version, setVersion] = useState<Version | null>(null);
  useEffect(() => {
    let live = true;
    api.get<Version>('/api/version').then(v => live && setVersion(v), () => {});
    return () => {
      live = false;
    };
  }, []);
  return version;
}

export const versionText = ({ version, commit }: Version) => `${version} · ${commit.slice(0, 7)}`;

/* Small and muted in the bottom right of every screen. */
export function VersionMark() {
  const version = useVersion();
  return version && <span className="version-mark">{versionText(version)}</span>;
}
