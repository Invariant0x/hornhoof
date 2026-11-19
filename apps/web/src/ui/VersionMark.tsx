import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { api } from '../api';
import { guardedResizeObserver } from '../guard';
import { FLOAT_GAP } from './canvas';

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

/* A box on the screen from its left to its right and its top to its bottom. */
type Edges = { left: number; right: number; top: number; bottom: number };

/* How far the version over the map rises from where the room puts it, to stand FLOAT_GAP clear over the bars that stand in its
   column, the highest of them stacked there: at, its box now, risen by was; bars, the map's bars along its bottom. */
export function cornerLift(at: Edges, was: number, bars: readonly Edges[]): number {
  const base = at.bottom + was, height = at.bottom - at.top;
  let bottom = base;
  for (const bar of [...bars].sort((a, b) => b.bottom - a.bottom)) {
    const drawn = bar.right > bar.left && bar.bottom > bar.top, inColumn = bar.left < at.right && at.left < bar.right;
    const clear = bar.top - FLOAT_GAP >= bottom || bar.bottom + FLOAT_GAP <= bottom - height;
    if (drawn && inColumn && !clear) bottom = bar.top - FLOAT_GAP;
  }
  return base - bottom;
}

/* How far the version rises over the bars of the map in its corner, measured as the map opens, as its bars come, go or grow,
   and as the screen changes size. bars: the map's bars; shown: what says which of them stand now. */
function useCornerLift(mark: RefObject<HTMLElement | null>, bars: string, shown: string): number {
  const [lift, setLift] = useState(0);
  const was = useRef(0);
  useLayoutEffect(() => {
    const el = mark.current, map = el?.closest('.map');
    if (!el || !map || !bars) return;
    const measure = () => {
      const next = Math.ceil(cornerLift(el.getBoundingClientRect(), was.current, [...map.querySelectorAll(bars)].map(bar => bar.getBoundingClientRect())));
      if (next !== was.current) setLift((was.current = next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = guardedResizeObserver(measure, 'map-version');
    for (const part of [map, el, ...map.querySelectorAll(bars)]) observer.observe(part);
    return () => observer.disconnect();
  }, [mark, bars, shown]);
  return lift;
}

/* The running build over the map, in the bottom end corner of the room its bars leave free, read left to right on any page.
   Where a bar of the map stands in that corner, as the zoom does on a wide screen right to left, it stands on that bar. It is
   on the map from the moment the map opens, even before the build answers, so the footer row never comes and goes under the
   map (#1590). bars: the map's bars along its bottom; shown: what says which of them stand now. */
export function MapVersion({ bars = '', shown = '' }: { bars?: string; shown?: string }) {
  const version = useVersion();
  const mark = useRef<HTMLParagraphElement>(null);
  const lift = useCornerLift(mark, bars, shown);
  return (
    <p className="map-version" ref={mark} style={lift ? ({ '--lift': `${lift}px` } as CSSProperties) : undefined}>
      {version && <bdi dir="ltr">{versionText(version)}</bdi>}
    </p>
  );
}
