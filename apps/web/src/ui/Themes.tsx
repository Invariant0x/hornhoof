import { useEffect, useId, useRef, useState, useSyncExternalStore, type ChangeEvent, type CSSProperties } from 'react';
import { useLanguage, useT, type Language } from '../i18n';
import { en, type Messages } from '../i18n/en';
import { ru } from '../i18n/ru';
import { COLLECTION_LIMIT, uniqueName, type CustomSkin } from '../skins/collection';
import { BUILTIN_SKINS, DEFAULT_SKIN, ownLook, type BuiltinSkinId } from '../skins/registry';
import { declarations, type Skin, type SkinLook, type SkinNames } from '../skins/roles';
import { addSkin, chooseSkin, removeSkin, restoreSkin, skinsState, subscribeSkins, type Removal } from '../skins/store';
import { builtinFile, parseSkin, SEE_THROUGH, SKIN_FILE_LIMIT, skinText, type SkinError } from '../skins/validate';

/* The Themes section of a person's settings, after the reference of Design (#787): a card for every built-in skin and
   every one of their own, one click to apply one, a file to add, any skin to download as a sample, and the guide to
   making one. Anyone signed in has it: what it changes stays in this browser. */

type Problem = SkinError | { code: 'read_failed'; key?: undefined; value?: undefined };
/* The line under the heading that says what the last action did: a status, an alert, or a file still being read. */
type Notice = { tone: 'status' | 'alert' | 'busy'; title?: string; text: string; removal?: Removal };
type Card = { id: string; look: SkinLook; name: string; desc: string; own: boolean; file: () => Skin };

const useSkins = () => useSyncExternalStore(subscribeSkins, skinsState);

const nameIn = (names: SkinNames, language: Language) => (language === 'ru' ? names.ru : names.en);
const builtinNames = (id: BuiltinSkinId): SkinNames => ({ ru: ru.skins.names[id], en: en.skins.names[id] });

/* The name people see: a built-in skin's in the language of the page, one's own as its file names it. */
function skinName(t: Messages, language: Language, id: string, custom: readonly CustomSkin[]): string {
  const own = custom.find(entry => entry.id === id);
  return own ? nameIn(own.skin.name, language) : t.skins.names[id as BuiltinSkinId];
}

/* The tokens of a skin on its own preview only, so each card shows its skin in the same drawing. */
const previewStyle = (look: SkinLook) => Object.fromEntries(declarations(look).filter(([property]) => property.startsWith('--'))) as CSSProperties;

function problemText(t: Messages, problem: Problem): string {
  const value = problem.code === 'bad_base' ? BUILTIN_SKINS.map(skin => skin.id).join(', ') : problem.code === 'opaque' ? SEE_THROUGH.join(', ') : (problem.value ?? '');
  return t.skins.errors[problem.code](problem.key ?? '', value);
}

async function readSkin(file: File): Promise<Skin | Problem> {
  if (file.size > SKIN_FILE_LIMIT) return { code: 'too_large' };
  try {
    const parsed = parseSkin(await file.text());
    return parsed.ok ? parsed.skin : parsed.error;
  } catch {
    return { code: 'read_failed' };
  }
}

/* One row of the account menu: where the themes are, and which one is on. */
export function ThemesMenuItem({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  const { language } = useLanguage();
  const { active, custom } = useSkins();
  const name = skinName(t, language, active, custom);
  return (
    <button className="menu-link" type="button" aria-label={t.skins.go(name)} onClick={onOpen}>
      <span>{t.skins.title}</span>
      <span className="menu-value">
        {name}
        <span className="menu-arrow" aria-hidden="true">›</span>
      </span>
    </button>
  );
}

/* Two labels in one place, the other one hidden but holding its room, so a button keeps its size when its label changes. */
function SwapLabel({ first, second, showSecond }: { first: string; second: string; showSecond: boolean }) {
  return (
    <span className="swap-label">
      <span className={showSecond ? 'sizer' : undefined} aria-hidden={showSecond || undefined}>
        {first}
      </span>
      <span className={showSecond ? undefined : 'sizer'} aria-hidden={!showSecond || undefined}>
        {second}
      </span>
    </span>
  );
}

/* The same small task card in the colours and fonts of each skin. It shows, it does nothing. */
function Preview({ look }: { look: SkinLook }) {
  const words = useT().skins.preview;
  return (
    <div className="skin-preview" style={previewStyle(look)} data-cut={look.shape} aria-hidden="true">
      <div className="sp-row">
        <span className="sp-label">{words.task}</span>
        <span className="sp-status">{words.ready}</span>
      </div>
      <p className="sp-note">{words.note}</p>
      <div className="sp-line" />
      <div className="sp-row">
        <span className="sp-label">{words.product}</span>
        <span className="sp-btn">{words.open}</span>
      </div>
    </div>
  );
}

type CardProps = { card: Card; on: boolean; onApply: () => void; onDownload: () => void; onRemove: () => void };

function SkinCard({ card, on, onApply, onDownload, onRemove }: CardProps) {
  const t = useT();
  const words = t.skins;
  const origin = card.own ? words.own : card.id === DEFAULT_SKIN ? `${words.builtIn} · ${words.byDefault}` : words.builtIn;
  const state = on ? words.applied : words.apply;
  return (
    <li className="skin-card" data-current={on || undefined}>
      <Preview look={card.look} />
      <div className="skin-card-text">
        <div className="skin-card-head">
          <h5 className="skin-name">{card.name}</h5>
          {on && <span className="skin-current">{words.current}</span>}
        </div>
        <p className="skin-meta">{origin}</p>
        <p className="skin-meta">{card.desc}</p>
      </div>
      <div className="entry-actions skin-actions">
        <button className={on ? 'btn small ghost' : 'btn small'} type="button" aria-pressed={on} aria-label={`${state}: ${card.name}`} data-apply={card.id} onClick={onApply}>
          <SwapLabel first={words.apply} second={words.applied} showSecond={on} />
        </button>
        <button className="btn small ghost" type="button" aria-label={`${words.download}: ${card.name}`} onClick={onDownload}>
          {words.download}
        </button>
        {card.own && (
          <button className="btn small ghost danger" type="button" aria-label={`${words.remove}: ${card.name}`} onClick={onRemove}>
            {words.remove}
          </button>
        )}
      </div>
    </li>
  );
}

function NoticeBar({ notice, onUndo }: { notice: Notice; onUndo: (removal: Removal) => void }) {
  const t = useT();
  const { removal } = notice;
  return (
    <div className="skins-notice" data-tone={notice.tone} role={notice.tone === 'alert' ? 'alert' : 'status'} aria-busy={notice.tone === 'busy' || undefined}>
      {notice.title && <p className="skins-notice-title">{notice.title}</p>}
      <p>{notice.text}</p>
      {removal && (
        <div className="entry-actions">
          <button className="btn small ghost" type="button" onClick={() => onUndo(removal)}>
            {t.skins.undo}
          </button>
        </div>
      )}
    </div>
  );
}

/* Three steps, the request to give an AI with the sample, and why the layout never changes. */
function Guide() {
  const t = useT();
  const id = useId();
  const [copied, setCopied] = useState<boolean | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(t.skins.aiRequest);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="skins-guide" aria-labelledby={id}>
      <h4 id={id}>{t.skins.guide}</h4>
      <ol>{t.skins.steps.map(step => <li key={step}>{step}</li>)}</ol>
      <div className="entry-actions">
        <button className="btn small ghost" type="button" onClick={() => void copy()}>
          {t.skins.askAi}
        </button>
      </div>
      {copied !== null && <p className="skins-copied" role="status">{copied ? t.skins.copied : t.skins.notCopied}</p>}
      <p className="skins-note">{t.skins.note}</p>
    </section>
  );
}

/* Gives a skin as a file of the format a person can change and add back. */
function saveFile(card: Card): void {
  const link = document.createElement('a');
  link.href = `data:application/json;charset=utf-8,${encodeURIComponent(skinText(card.file()))}`;
  link.download = `hornhoof-skin-${card.id}.json`;
  document.body.append(link);
  link.click();
  link.remove();
}

export function Themes() {
  const t = useT();
  const { language } = useLanguage();
  const { active, custom } = useSkins();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [reading, setReading] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /* Where focus goes once the catalog has drawn again: the Apply of a card, or Add from file. */
  const focusTo = useRef<string | null>(null);
  const headingId = useId();
  const catalogId = useId();

  useEffect(() => {
    if (focusTo.current === null) return;
    const target = root.current?.querySelector<HTMLElement>(`[data-apply="${focusTo.current}"]`) ?? addButton.current;
    focusTo.current = null;
    target?.focus();
  });

  const cards: Card[] = [
    ...BUILTIN_SKINS.map(skin => ({ id: skin.id, look: skin, name: t.skins.names[skin.id], desc: t.skins.descs[skin.id], own: false, file: () => builtinFile(skin, builtinNames(skin.id)) })),
    ...custom.map(({ id, skin }) => ({ id, look: ownLook(skin), name: nameIn(skin.name, language), desc: t.skins.ownDesc, own: true, file: () => skin })),
  ];

  const fail = (text: string) => setNotice({ tone: 'alert', title: t.skins.addFailed, text });

  function keepRead(skin: Skin) {
    const taken = [...BUILTIN_SKINS.map(builtin => builtinNames(builtin.id)), ...skinsState().custom.map(entry => entry.skin.name)];
    const named = { ...skin, name: uniqueName(skin.name, taken) };
    const added = addSkin(named);
    if (added.ok) setNotice({ tone: 'status', text: t.skins.added(nameIn(named.name, language)) });
    else fail(added.reason === 'full' ? t.skins.full(COLLECTION_LIMIT) : t.skins.notKept);
  }

  async function load(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    /* The same file can be picked again after it is fixed; no file picked changes nothing. */
    input.value = '';
    if (!file) return;
    setReading(true);
    setNotice({ tone: 'busy', text: t.skins.busy });
    const read = await readSkin(file);
    setReading(false);
    if ('code' in read) fail(problemText(t, read));
    else keepRead(read);
    focusTo.current = '';
  }

  function apply(card: Card) {
    if (card.id === active || !chooseSkin(card.id)) return;
    setNotice({ tone: 'status', text: t.skins.nowOn(card.name) });
  }

  function download(card: Card) {
    try {
      saveFile(card);
    } catch {
      setNotice({ tone: 'alert', text: t.skins.downloadFailed(card.name) });
    }
  }

  function remove(card: Card) {
    const at = cards.indexOf(card);
    const removal = removeSkin(card.id);
    if (!removal) return;
    const fellBack = removal.wasOn ? ` ${t.skins.nowOn(t.skins.names[DEFAULT_SKIN])}` : '';
    setNotice({ tone: 'status', text: `${t.skins.removed(card.name)}${fellBack}`, removal });
    focusTo.current = (cards[at + 1] ?? cards[at - 1])?.id ?? '';
  }

  function undo(removal: Removal) {
    const back = restoreSkin(removal);
    if (!back) return fail(t.skins.notKept);
    setNotice({ tone: 'status', text: t.skins.restored(nameIn(back.skin.name, language)) });
    focusTo.current = back.id;
  }

  return (
    <div className="skins" ref={root}>
      <div className="skins-head">
        <div className="skins-intro">
          <h3 id={headingId} tabIndex={-1} data-autofocus>
            {t.skins.title}
          </h3>
          <p>{t.skins.desc}</p>
          <p className="muted">{t.skins.local}</p>
        </div>
        <div className="skins-add">
          <button ref={addButton} className="btn small" type="button" disabled={reading} aria-busy={reading || undefined} onClick={() => fileInput.current?.click()}>
            <SwapLabel first={t.skins.add} second={t.skins.loading} showSecond={reading} />
          </button>
          <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={event => void load(event)} />
        </div>
      </div>
      {notice && <NoticeBar notice={notice} onUndo={undo} />}
      <section className="skins-catalog" aria-labelledby={catalogId}>
        <div className="skins-catalog-head">
          <h4 id={catalogId}>{t.skins.catalog}</h4>
          <p className="muted">{t.skins.catalogHint}</p>
        </div>
        <ul className="skin-cards">
          {cards.map(card => (
            <SkinCard key={card.id} card={card} on={card.id === active} onApply={() => apply(card)} onDownload={() => download(card)} onRemove={() => remove(card)} />
          ))}
        </ul>
        {custom.length === 0 && (
          <div className="skins-empty">
            <p className="skins-empty-title">{t.skins.empty}</p>
            <p className="muted">{t.skins.emptyHint}</p>
          </div>
        )}
      </section>
      <Guide />
    </div>
  );
}
