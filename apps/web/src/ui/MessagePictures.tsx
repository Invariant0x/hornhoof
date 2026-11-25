import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { api, ApiFailure } from '../api';
import { useT } from '../i18n';
import { isHidden } from './visibility';

/* What the server keeps: apps/server/src/modules/conversation/pictures.ts. A big picture goes smaller to PICTURE_BYTES
   first, so the agent's program reads it whole; any other file goes as it is. */
const PICTURE_BYTES = 3 * 1024 * 1024;
const FILE_BYTES = 10 * 1024 * 1024;
const PER_MESSAGE = 10;
/* What the window shows as a picture before it goes. */
const SHOWN = ['image/png', 'image/jpeg', 'image/webp'];
/* A sheet with a folded corner, for a file that shows no picture. */
const FILE_ICON = 'M7 3h7l5 5v13H7zM14 3v5h5';
/* How far a big picture is scaled down, in turn, before it is turned away. */
const SCALES = [1, 0.75, 0.5, 0.35];
const JPEG_QUALITY = 0.85;
/* Panels stand in the window's box though they show beside it, with fields of their own. */
const PANELS = '.side-panels';
const FIELDS = 'input, textarea, select, [contenteditable="true"]';
const OWN_FIELDS = '.t-in textarea, .xterm-helper-textarea';

/* preview: the picture to show, or null for a file that waits by its name. */
export type Draft = { key: number; file: Blob; name: string; preview: string | null };
type Refusal = 'file_empty' | 'file_too_big' | 'pictures_too_many';
const refusal = (reason: Refusal) => new ApiFailure(400, 'validation', '', reason);

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
const elementOf = (target: EventTarget | null) => (target instanceof Element ? target : target instanceof Node ? target.parentElement : null);
const inPanel = (target: EventTarget | null) => Boolean(elementOf(target)?.closest(PANELS));

/* Nothing else on the page takes a file, so one pasted with the window showing is for it, wherever the focus is, unless it
   goes into a field of its own. */
const pasteIsForLine = (target: EventTarget | null, box: HTMLElement) => !isHidden(box) && target instanceof Element && (!target.closest(FIELDS) || target.matches(OWN_FIELDS));

/* The file as JPEG at the first scale that fits, or nothing when none does or it is no picture a browser can read. */
async function shrunk(file: File): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function') return null;
  const image = await createImageBitmap(file).catch(() => null);
  if (!image) return null;
  try {
    for (const scale of SCALES) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      const paint = canvas.getContext('2d');
      if (!paint) return null;
      /* JPEG has no transparency, and what shows through a screenshot is white. */
      paint.fillStyle = '#fff';
      paint.fillRect(0, 0, canvas.width, canvas.height);
      paint.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(done => canvas.toBlob(done, 'image/jpeg', JPEG_QUALITY));
      if (blob && blob.size <= PICTURE_BYTES) return blob;
    }
    return null;
  } finally {
    image.close();
  }
}

const asJpeg = (name: string) => `${name.replace(/\.[^.]*$/, '')}.jpg`;

/* The bytes to send of a file, or why it does not go. A big picture goes smaller when it can, and as it is when it cannot. */
export async function readied(file: File): Promise<{ file: Blob; name: string } | Refusal> {
  if (!file.size) return 'file_empty';
  if (SHOWN.includes(file.type) && file.size > PICTURE_BYTES) {
    const smaller = await shrunk(file);
    if (smaller) return { file: smaller, name: asJpeg(file.name) };
  }
  return file.size <= FILE_BYTES ? { file, name: file.name } : 'file_too_big';
}

const letGo = (d: Draft) => d.preview && URL.revokeObjectURL(d.preview);

/* The pictures and other files waiting at the line to go with the next message. One that is up keeps its id, so sending
   again after a failure does not put it up twice. */
export function useDraftPictures(path: string) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<unknown>(null);
  const current = useRef<Draft[]>([]);
  const nextKey = useRef(0);
  const ids = useRef(new Map<number, string>());
  const adding = useRef(Promise.resolve());

  const change = useCallback((next: Draft[]) => {
    current.current = next;
    setDrafts(next);
  }, []);

  const addOne = useCallback(
    async (file: File) => {
      if (current.current.length >= PER_MESSAGE) return setRefused(refusal('pictures_too_many'));
      const ready = await readied(file);
      if (typeof ready === 'string') return setRefused(refusal(ready));
      const preview = SHOWN.includes(ready.file.type) ? URL.createObjectURL(ready.file) : null;
      change([...current.current, { ...ready, key: ++nextKey.current, preview }]);
    },
    [change],
  );

  /* One at a time, in the order they came, however many are dropped while a big one is made smaller. */
  const add = useCallback(
    (files: File[]) => {
      setRefused(null);
      adding.current = files.reduce((before, file) => before.then(() => addOne(file)), adding.current);
    },
    [addOne],
  );

  const drop = useCallback(
    (gone: Draft[]) => {
      gone.forEach(letGo);
      change(current.current.filter(d => !gone.includes(d)));
    },
    [change],
  );

  const remove = useCallback(
    (draft: Draft) => {
      setRefused(null);
      drop([draft]);
    },
    [drop],
  );

  /* The browser could not show it, so whatever its name says it is no picture: it waits by its name and goes as it is. */
  const asFile = useCallback(
    (draft: Draft) => {
      letGo(draft);
      change(current.current.map(d => (d.key === draft.key ? { ...d, preview: null } : d)));
    },
    [change],
  );

  const upload = useCallback(
    async (draft: Draft) => {
      const had = ids.current.get(draft.key);
      if (had) return had;
      const { id } = await api.upload<{ id: string }>(`${path}/pictures?name=${encodeURIComponent(draft.name)}`, draft.file);
      ids.current.set(draft.key, id);
      return id;
    },
    [path],
  );

  /* Puts up what is not up yet and hands the ids to post; the pictures stay until that worked. */
  const deliver = useCallback(
    async (post: (pictures: string[]) => Promise<unknown>) => {
      const going = current.current;
      setRefused(null);
      if (going.length) setSending(true);
      try {
        const up: string[] = [];
        for (const draft of going) up.push(await upload(draft));
        await post(up);
        const sent = new Set(going.map(d => d.key));
        drop(current.current.filter(d => sent.has(d.key)));
      } finally {
        setSending(false);
      }
    },
    [drop, upload],
  );

  useEffect(() => () => current.current.forEach(letGo), []);

  return { drafts, sending, refused, setRefused, add, remove, asFile, deliver };
}

type Drags = { accepting: boolean; exclusive: boolean; depth: { current: number }; setDragging(on: boolean): void; add(files: File[]): void };

const takes = (e: DragEvent, d: Drags) => d.accepting && hasFiles(e) && !inPanel(e.target);
const owns = (e: DragEvent, d: Drags) => d.exclusive && hasFiles(e) && !inPanel(e.target);

function dragIn(e: DragEvent, d: Drags) {
  if (owns(e, d)) e.stopPropagation();
  if (!takes(e, d)) return;
  e.preventDefault();
  d.depth.current += 1;
  d.setDragging(true);
}

function dragOut(e: DragEvent, d: Drags) {
  if (owns(e, d)) e.stopPropagation();
  if (!takes(e, d)) return;
  d.depth.current = Math.max(0, d.depth.current - 1);
  if (!d.depth.current) d.setDragging(false);
}

function dragOver(e: DragEvent, d: Drags) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (owns(e, d)) e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = takes(e, d) ? 'copy' : 'none';
}

function dropped(e: DragEvent, d: Drags) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (owns(e, d)) e.stopPropagation();
  d.depth.current = 0;
  d.setDragging(false);
  if (takes(e, d)) d.add(Array.from(e.dataTransfer?.files ?? []));
}

/* Past the box: a browser opens a file dropped on a page in place of the page. Each open box keeps its own listener, so
   closing another window never leaves the one on the screen without it. */
function keepPage(e: DragEvent) {
  if (hasFiles(e)) e.preventDefault();
}

function pasted(e: ClipboardEvent, box: HTMLElement, accepting: boolean, add: (files: File[]) => void) {
  const said = e.clipboardData;
  if (!said || said.getData('text/plain')) return;
  const files = Array.from(said.files);
  if (!files.length || !pasteIsForLine(e.target, box)) return;
  e.preventDefault();
  e.stopPropagation();
  if (accepting) add(files);
}

/* Dragging files over the window and pasting a picture or another file while it shows. A file that misses the window stays from replacing
   the page, for as long as it is open. Native listeners, from the commit the window shows in: the program in the terminal
   must not see an image pasted, the box holds panels with their own fields, and a file dropped a moment too early would
   replace the page. An exclusive box takes its own paste before an outer window and keeps its drops from that window. */
export function usePictureDrop(box: RefObject<HTMLElement | null>, on: boolean, accepting: boolean, add: (files: File[]) => void, exclusive = false): boolean {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  useLayoutEffect(() => {
    const el = box.current;
    if (!on || !el) return;
    const d: Drags = { accepting, exclusive, depth, setDragging, add };
    const onEnter = (e: DragEvent) => dragIn(e, d);
    const onLeave = (e: DragEvent) => dragOut(e, d);
    const onOver = (e: DragEvent) => dragOver(e, d);
    const onDrop = (e: DragEvent) => dropped(e, d);
    const onPage = (e: DragEvent) => keepPage(e);
    el.addEventListener('dragenter', onEnter);
    el.addEventListener('dragleave', onLeave);
    el.addEventListener('dragover', onOver);
    el.addEventListener('drop', onDrop);
    document.addEventListener('dragover', onPage);
    document.addEventListener('drop', onPage);
    return () => {
      el.removeEventListener('dragenter', onEnter);
      el.removeEventListener('dragleave', onLeave);
      el.removeEventListener('dragover', onOver);
      el.removeEventListener('drop', onDrop);
      document.removeEventListener('dragover', onPage);
      document.removeEventListener('drop', onPage);
      depth.current = 0;
      setDragging(false);
    };
  }, [accepting, add, box, exclusive, on]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!on || (!accepting && !exclusive) || !el) return;
    const root = exclusive ? window : document;
    const onPaste = (e: Event) => pasted(e as ClipboardEvent, el, accepting, add);
    root.addEventListener('paste', onPaste, true);
    return () => root.removeEventListener('paste', onPaste, true);
  }, [accepting, add, box, exclusive, on]);

  return dragging;
}

const FileIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d={FILE_ICON} />
  </svg>
);

/* The pictures and files waiting at the line, small, each with its way out: a picture as itself, any other file by its
   name. */
export function PictureTray({ drafts, sending, onRemove, onBroken }: { drafts: Draft[]; sending: boolean; onRemove(d: Draft): void; onBroken(d: Draft): void }) {
  const t = useT();
  if (!drafts.length) return null;
  return (
    <div className="t-tray" aria-busy={sending}>
      {drafts.map(d => (
        <div key={d.key} className={d.preview ? 't-tray-pic' : 't-tray-file'}>
          {d.preview ? (
            <img src={d.preview} alt={d.name} title={d.name} onError={() => onBroken(d)} />
          ) : (
            <>
              <FileIcon />
              <span>{d.name}</span>
            </>
          )}
          <button type="button" aria-label={t.window.removePicture(d.name)} title={t.window.removePicture(d.name)} disabled={sending} onClick={() => onRemove(d)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/* Choosing pictures and other files with a button, for a phone or a keyboard, where nothing is dragged. */
export function AddPicture({ id, disabled, onFiles }: { id: string; disabled: boolean; onFiles(files: File[]): void }) {
  const t = useT();
  return (
    <label className="t-add" htmlFor={id} title={t.window.addPicture}>
      <span className="sr">{t.window.addPicture}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
      </svg>
      <input
        id={id}
        className="sr"
        type="file"
        multiple
        disabled={disabled}
        onChange={e => {
          onFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
    </label>
  );
}

function SentPicture({ id, name }: { id: string; name: string }) {
  const t = useT();
  const [gone, setGone] = useState(false);
  if (gone) return <span className="t-pic-gone">{t.window.pictureGone(name)}</span>;
  const src = `/api/attachments/${id}`;
  return (
    <a href={src} target="_blank" rel="noreferrer" aria-label={t.window.openPicture(name)} title={t.window.openPicture(name)}>
      <img src={src} alt={name} onError={() => setGone(true)} />
    </a>
  );
}

/* A file that is no picture, by its name, to download. */
function SentFile({ id, name }: { id: string; name: string }) {
  const t = useT();
  return (
    <a className="t-file" href={`/api/attachments/${id}`} download={name} aria-label={t.window.downloadFile(name)} title={t.window.downloadFile(name)}>
      <FileIcon />
      <span>{name}</span>
    </a>
  );
}

/* The pictures and files of a person's message, whether its text is folded or not; a picture opens large, a file downloads. */
export function SentPictures({ data }: { data: unknown }) {
  const pictures = (data as { pictures?: { id: string; name: string; file?: boolean }[] } | null)?.pictures ?? [];
  if (!pictures.length) return null;
  return (
    <div className="t-pics">
      {pictures.map(p => (p.file ? <SentFile key={p.id} id={p.id} name={p.name} /> : <SentPicture key={p.id} id={p.id} name={p.name} />))}
    </div>
  );
}
