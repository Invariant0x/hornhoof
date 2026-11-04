import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { api, ApiFailure } from '../api';
import { useT } from '../i18n';
import { isHidden } from './visibility';

/* What the server keeps: apps/server/src/modules/tasks/attachments.ts and conversation/pictures.ts. */
const PICTURE_BYTES = 3 * 1024 * 1024;
const PER_MESSAGE = 10;
const TAKEN = ['image/png', 'image/jpeg', 'image/webp'];
export const TAKEN_TYPES = TAKEN.join(',');
/* How far a big picture is scaled down, in turn, before it is turned away. */
const SCALES = [1, 0.75, 0.5, 0.35];
const JPEG_QUALITY = 0.85;
/* Panels stand in the window's box though they show beside it, with fields of their own. */
const PANELS = '.side-panels';
const FIELDS = 'input, textarea, select, [contenteditable="true"]';
const OWN_FIELDS = '.t-in textarea, .xterm-helper-textarea';

export type Draft = { key: number; file: Blob; name: string; preview: string };
type Refusal = 'picture_invalid' | 'picture_too_big' | 'pictures_too_many';
const refusal = (reason: Refusal) => new ApiFailure(400, 'validation', '', reason);

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
const inPanel = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(PANELS));

/* Nothing else on the page takes a picture, so one pasted with the window showing is for it, wherever the focus is, unless
   it goes into a field of its own. */
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

/* The bytes to send of a file, or why it does not go. */
async function readied(file: File): Promise<{ file: Blob; name: string } | Refusal> {
  if (!TAKEN.includes(file.type)) return 'picture_invalid';
  if (file.size <= PICTURE_BYTES) return { file, name: file.name };
  const smaller = await shrunk(file);
  return smaller ? { file: smaller, name: asJpeg(file.name) } : 'picture_too_big';
}

/* The pictures waiting at the line to go with the next message. A picture that is up keeps its id, so sending again after
   a failure does not put it up twice. */
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
      change([...current.current, { ...ready, key: ++nextKey.current, preview: URL.createObjectURL(ready.file) }]);
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
      for (const d of gone) URL.revokeObjectURL(d.preview);
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

  /* The browser could not show it, so whatever its name says it is no picture. */
  const notPicture = useCallback(
    (draft: Draft) => {
      drop([draft]);
      setRefused(refusal('picture_invalid'));
    },
    [drop],
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
        drop(going);
      } finally {
        setSending(false);
      }
    },
    [drop, upload],
  );

  useEffect(() => () => current.current.forEach(d => URL.revokeObjectURL(d.preview)), []);

  return { drafts, sending, refused, setRefused, add, remove, notPicture, deliver };
}

type Drags = { accepting: boolean; depth: { current: number }; setDragging(on: boolean): void; add(files: File[]): void };

const takes = (e: DragEvent, d: Drags) => d.accepting && hasFiles(e) && !inPanel(e.target);

function dragIn(e: DragEvent, d: Drags) {
  if (!takes(e, d)) return;
  d.depth.current += 1;
  d.setDragging(true);
}

function dragOut(e: DragEvent, d: Drags) {
  if (!takes(e, d)) return;
  d.depth.current = Math.max(0, d.depth.current - 1);
  if (!d.depth.current) d.setDragging(false);
}

function dragOver(e: DragEvent, d: Drags) {
  if (hasFiles(e) && e.dataTransfer) e.dataTransfer.dropEffect = takes(e, d) ? 'copy' : 'none';
}

function dropped(e: DragEvent, d: Drags) {
  if (!hasFiles(e)) return;
  d.depth.current = 0;
  d.setDragging(false);
  if (takes(e, d)) d.add(Array.from(e.dataTransfer?.files ?? []));
}

/* Here and past the box: a browser opens a file dropped on a page in place of the page. This also lets a file drop at all. */
function keepPage(e: DragEvent) {
  if (hasFiles(e)) e.preventDefault();
}

function pasted(e: ClipboardEvent, box: HTMLElement, add: (files: File[]) => void) {
  const said = e.clipboardData;
  if (!said || said.getData('text/plain')) return;
  const files = Array.from(said.files);
  if (!files.some(f => f.type.startsWith('image/')) || !pasteIsForLine(e.target, box)) return;
  e.preventDefault();
  e.stopPropagation();
  add(files);
}

/* Dragging files over the window and pasting a picture while it shows. A file that misses the window stays from replacing
   the page, for as long as it is open. Native listeners, from the commit the window shows in: the program in the terminal
   must not see an image pasted, the box holds panels with their own fields, and a file dropped a moment too early would
   replace the page. */
export function usePictureDrop(box: RefObject<HTMLElement | null>, on: boolean, accepting: boolean, add: (files: File[]) => void): boolean {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  useLayoutEffect(() => {
    const el = box.current;
    if (!on || !el) return;
    const d: Drags = { accepting, depth, setDragging, add };
    const onEnter = (e: DragEvent) => dragIn(e, d);
    const onLeave = (e: DragEvent) => dragOut(e, d);
    const onOver = (e: DragEvent) => dragOver(e, d);
    const onDrop = (e: DragEvent) => dropped(e, d);
    el.addEventListener('dragenter', onEnter);
    el.addEventListener('dragleave', onLeave);
    el.addEventListener('dragover', onOver);
    el.addEventListener('drop', onDrop);
    document.addEventListener('dragover', keepPage);
    document.addEventListener('drop', keepPage);
    return () => {
      el.removeEventListener('dragenter', onEnter);
      el.removeEventListener('dragleave', onLeave);
      el.removeEventListener('dragover', onOver);
      el.removeEventListener('drop', onDrop);
      document.removeEventListener('dragover', keepPage);
      document.removeEventListener('drop', keepPage);
      depth.current = 0;
      setDragging(false);
    };
  }, [accepting, add, box, on]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!on || !accepting || !el) return;
    const onPaste = (e: ClipboardEvent) => pasted(e, el, add);
    document.addEventListener('paste', onPaste, true);
    return () => document.removeEventListener('paste', onPaste, true);
  }, [accepting, add, box, on]);

  return dragging;
}

/* The pictures waiting at the line, small, each with its way out. */
export function PictureTray({ drafts, sending, onRemove, onBroken }: { drafts: Draft[]; sending: boolean; onRemove(d: Draft): void; onBroken(d: Draft): void }) {
  const t = useT();
  if (!drafts.length) return null;
  return (
    <div className="t-tray" aria-busy={sending}>
      {drafts.map(d => (
        <div key={d.key} className="t-tray-pic">
          <img src={d.preview} alt={d.name} title={d.name} onError={() => onBroken(d)} />
          <button type="button" aria-label={t.window.removePicture(d.name)} title={t.window.removePicture(d.name)} disabled={sending} onClick={() => onRemove(d)}>
            ×
          </button>
        </div>
      ))}
      <button className="btn small" type="submit" disabled={sending}>
        {t.window.sendPictures}
      </button>
    </div>
  );
}

/* Choosing pictures with a button, for a phone or a keyboard, where nothing is dragged. */
export function AddPicture({ id, disabled, onFiles }: { id: string; disabled: boolean; onFiles(files: File[]): void }) {
  const t = useT();
  return (
    <label className="t-add" htmlFor={id} title={t.window.addPicture}>
      <span className="sr">{t.window.addPicture}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 6h16v12H4zM4 15l5-4 4 3 3-2 4 3M15 9.5h.01" />
      </svg>
      <input
        id={id}
        className="sr"
        type="file"
        accept={TAKEN_TYPES}
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

/* The pictures of a person's message, whether its text is folded or not; each opens large. */
export function SentPictures({ data }: { data: unknown }) {
  const pictures = (data as { pictures?: { id: string; name: string }[] } | null)?.pictures ?? [];
  if (!pictures.length) return null;
  return (
    <div className="t-pics">
      {pictures.map(p => (
        <SentPicture key={p.id} id={p.id} name={p.name} />
      ))}
    </div>
  );
}
