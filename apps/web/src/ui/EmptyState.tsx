import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { LogoMark, TrackerIcon } from './icons';

type Icon = Parameters<typeof TrackerIcon>[0]['name'];

/* The one thing a person can do about a section that holds nothing: make what it would hold. */
export type EmptyAction = { label: string; onClick: () => void };

/* How an empty place says so (Design #1633, style book 1.7 section 4): block, a section of the tracker, with its icon, the
   fact, a hint where it helps and the one thing to do at its end; line, a compact place such as a board column, one sentence
   and no icon; first, a company with no tasks at all, its whole view under the Hornhoof mark. */
type EmptyProps = { icon?: Icon; text: string; hint?: string; action?: EmptyAction; form?: 'block' | 'line' | 'first'; status?: boolean };

/* What a place says once every source of it came and it holds nothing (#1638). Each sentence keeps the direction of its own
   language. status: its words are the place's one status. */
export function EmptyState({ icon, text, hint, action, form = 'block', status }: EmptyProps) {
  const role = status ? 'status' : undefined;
  if (form === 'line') return <p className="empty-line" role={role} dir="auto">{text}</p>;
  return (
    <div className={`empty-state ${form}`} role={role}>
      {form === 'first' ? <LogoMark className="load-mark" /> : icon && <TrackerIcon name={icon} className="empty-state-icon" />}
      <p className="empty-state-t" dir="auto"><b>{text}</b>{hint && <span>{hint}</span>}</p>
      {action && <div className="empty-state-acts"><button className="btn ghost" type="button" onClick={action.onClick}>{action.label}</button></div>}
    </div>
  );
}

const HEIGHT_KEY = 'hh-held-height:';

/* Below this width a room is narrow: its empty block puts the action under its words, and it holds 4 rows, not 2. */
const NARROW_PX = 560;

const widthOf = (room: HTMLElement) => (room.clientWidth < NARROW_PX ? 'narrow' : 'wide');

/* The height a list showed last in this tab at this width, kept per list for the session (Design #1633, amending #1611: a
   count of rows cannot hold titles that wrap). The tab may keep nothing, as a private window does; then none is known. */
function keptHeight(key: string): number | null {
  try {
    const px = Number(sessionStorage.getItem(HEIGHT_KEY + key));
    return px > 0 ? px : null;
  } catch {
    return null;
  }
}

function keepHeight(key: string, px: number): void {
  try {
    if (px > 0) sessionStorage.setItem(HEIGHT_KEY + key, String(Math.ceil(px)));
    else sessionStorage.removeItem(HEIGHT_KEY + key);
  } catch {
    /* Nothing kept: the room holds its rows. */
  }
}

/* The height a room holds for this visit, read once per list; and, once what came shows, its height kept for the next. */
function useHeldHeight(list: string | undefined, shown: boolean, none: boolean) {
  const room = useRef<HTMLDivElement>(null);
  const data = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState<number | null>(null);
  useLayoutEffect(() => {
    setHeld(list && room.current ? keptHeight(`${list}|${widthOf(room.current)}`) : null);
  }, [list]);
  useLayoutEffect(() => {
    if (list && shown && room.current) keepHeight(`${list}|${widthOf(room.current)}`, none ? 0 : (data.current?.offsetHeight ?? 0));
  });
  return { room, data, held };
}

/* A layer of a room that is not shown keeps its size, takes no click and is read by nobody. */
function Layer({ shown, className, style, children }: { shown: boolean; className?: string; style?: CSSProperties; children: ReactNode }) {
  const name = className ? `room-layer ${className}` : 'room-layer';
  return <div className={shown ? name : `${name} off`} style={style} aria-hidden={!shown || undefined} inert={!shown || undefined}>{children}</div>;
}

/* How tall what holds a room's place stands while it comes, kept once it is gone, so the empty block that takes the room
   then holds that height and nothing under it moves. Only for the list it held: another list, as the filters change, holds
   nothing of it, and the room stays the one element it was. */
function useHolderHeight(list: string | undefined) {
  const holder = useRef<HTMLDivElement>(null);
  const [kept, setKept] = useState({ list, px: 0 });
  useLayoutEffect(() => {
    const px = holder.current?.offsetHeight;
    if (px !== undefined && (px !== kept.px || list !== kept.list)) setKept({ list, px });
  });
  return { holder, height: kept.list === list ? kept.px : 0 };
}

/* The room of a section (Design #1633): what holds its place while it comes and its empty block stand in one grid cell, so
   loading and empty have one height and nothing under them moves when it came; what came then takes the room, which keeps
   the height it held for this visit and grows only at its end. done: every source of it came; none: and it holds nothing, so the empty block shows, and never before;
   until then it is drawn unseen, to size the room. list: which list it is, so the room holds the height it showed last in
   this tab. */
type RoomProps = { done: boolean; none: boolean; held: ReactNode; empty: ReactNode; list?: string; children?: ReactNode };

export function Room({ done, none, held, empty, list, children }: RoomProps) {
  const shown = done && !none;
  const { room, data, held: height } = useHeldHeight(list, done, none);
  const { holder, height: holderHeight } = useHolderHeight(list);
  const kept = done && holderHeight ? { minBlockSize: `${holderHeight}px` } : undefined;
  return (
    <div ref={room} className="room" style={height ? { minBlockSize: `${height}px` } : undefined}>
      {!done && <div ref={holder} className="room-layer">{held}</div>}
      {!shown && <Layer shown={done} className="room-empty" style={kept}>{empty}</Layer>}
      {shown && <div className="room-layer" style={kept}><div ref={data} className="room-data">{children}</div></div>}
    </div>
  );
}
