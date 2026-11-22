import { useEffect, useId, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT, type Language } from '../i18n';
import { en, type Messages } from '../i18n/en';
import { ru } from '../i18n/ru';
import { COLLECTION_LIMIT, uniqueName, type CustomSkin } from '../skins/collection';
import { BUILTIN_SKINS, DEFAULT_SKIN, ownLook, type BuiltinSkinId } from '../skins/registry';
import { declarations, extraDeclarations, type Skin, type SkinLook, type SkinNames } from '../skins/roles';
import { addSkin, chooseSkin, removeSkin, restoreSkin, setMapGrain, skinsState, type Removal } from '../skins/store';
import { useMapGrain, useSkins } from '../skins/use-skin';
import { builtinFile, parseSkin, SEE_THROUGH, SKIN_FILE_LIMIT, skinText, type SkinError } from '../skins/validate';
import { ThemeShopIcon } from './icons';

/* The Theme store section of a person's settings: full interactive world themes, classic built-in skins and every skin
   of their own, one click to apply one, a file to add, any skin to download as a sample, and the guide to making one.
   Anyone signed in has it: what it changes stays in this browser. */

type Problem = SkinError | { code: 'read_failed'; key?: undefined; value?: undefined };
/* The line under the heading that says what the last action did: a status, an alert, or a file still being read. */
type Notice = { tone: 'status' | 'alert' | 'busy'; title?: string; text: string; removal?: Removal };
type Card = { id: string; look: SkinLook; name: string; desc: string; own: boolean; file: () => Skin };
type StoreFilter = 'all' | 'worlds' | 'classic' | 'custom';
const STORE_FILTERS: readonly StoreFilter[] = ['all', 'worlds', 'classic', 'custom'];

const isWorldCard = (card: Card) => !!card.look.world && card.look.world !== 'standard';
function matchesFilter(card: Card, filter: StoreFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'worlds') return isWorldCard(card);
  if (filter === 'custom') return card.own;
  return !card.own && !isWorldCard(card);
}

const nameIn = (names: SkinNames, language: Language) => (language === 'ru' ? names.ru : names.en);
const builtinNames = (id: BuiltinSkinId): SkinNames => ({ ru: ru.skins.names[id], en: en.skins.names[id] });

/* The tokens of a skin on its own preview only, so each card shows its skin and world colours in the same drawing. */
const previewStyle = (look: SkinLook) =>
  Object.fromEntries([...declarations(look), ...extraDeclarations(look).set].filter(([property]) => property.startsWith('--'))) as CSSProperties;

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

/* Miniature desert panorama shown inside the Ancient Egypt theme card preview, using only semantic and world tokens. */
function EgyptPreviewScene() {
  return (
    <svg className="sp-world-banner" viewBox="0 0 240 54" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="240" height="54" fill="var(--world-ground, var(--bg))" />
      <path d="M0 39 Q68 32 128 41 T240 36 L240 54 L0 54 Z" fill="var(--world-field, var(--ok))" opacity="0.52" />
      <path d="M0 43 Q72 37 132 46 T240 41 L240 50 Q180 54 128 50 T0 48 Z" fill="var(--world-water, var(--cyan))" />
      <path d="M16 33 L88 22 L162 29 L224 19" fill="none" stroke="var(--world-path, var(--line))" strokeWidth="5" strokeLinecap="round" />
      <circle cx="204" cy="12" r="5.5" fill="var(--amber)" opacity="0.88" />
      <polygon points="34,34 66,8 98,34" fill="var(--world-structure, var(--line))" stroke="var(--line2)" strokeWidth="1" />
      <polygon points="66,8 98,34 73,34" fill="var(--world-shade, var(--shadow))" />
      <line x1="54" y1="18" x2="78" y2="18" stroke="var(--line2)" strokeWidth="0.8" />
      <line x1="44" y1="26" x2="88" y2="26" stroke="var(--line2)" strokeWidth="0.8" />
      <rect x="116" y="16" width="32" height="17" fill="var(--world-structure, var(--line))" stroke="var(--line2)" strokeWidth="1" />
      <line x1="123" y1="16" x2="123" y2="33" stroke="var(--line2)" strokeWidth="1" />
      <line x1="132" y1="16" x2="132" y2="33" stroke="var(--line2)" strokeWidth="1" />
      <line x1="141" y1="16" x2="141" y2="33" stroke="var(--line2)" strokeWidth="1" />
    </svg>
  );
}

/* The same small task card in the colours and fonts of each skin. It shows, it does nothing. */
function Preview({ look }: { look: SkinLook }) {
  const words = useT().skins.preview;
  const world = look.world && look.world !== 'standard' ? look.world : undefined;
  return (
    <div className="skin-preview" style={previewStyle(look)} data-cut={look.shape} data-world={world} aria-hidden="true">
      {world === 'egypt' && <EgyptPreviewScene />}
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

function cardOrigin(words: Messages['skins'], card: Card): string {
  if (card.own) return words.own;
  if (card.id === DEFAULT_SKIN) return `${words.builtIn} · ${words.byDefault}`;
  if (isWorldCard(card)) return `${words.builtIn} · ${words.worldBadge}`;
  return words.builtIn;
}

/* A skin's card: its preview, name, origin and description, then its quiet buttons on the end edge. The skin on says so
   by a state beside its name instead of Apply, and that state holds the focus once Apply is gone. */
function SkinCard({ card, on, onApply, onDownload, onRemove }: CardProps) {
  const t = useT();
  const words = t.skins;
  const origin = cardOrigin(words, card);
  const world = isWorldCard(card);
  return (
    <li className="skin-card" data-current={on || undefined} aria-current={on || undefined}>
      <Preview look={card.look} />
      <div className="skin-card-text">
        <div className="skin-card-head">
          <h6 className="skin-name">{card.name}</h6>
          {on && (
            <span className="skin-state" tabIndex={-1} data-focus-skin={card.id}>
              {words.applied}
            </span>
          )}
        </div>
        <p className="skin-meta">{origin}</p>
        <p className="skin-meta">{card.desc}</p>
        {world && <p className="skin-perf-note">{words.perfNote}</p>}
      </div>
      <div className="entry-actions skin-actions">
        {on ? (
          /* Apply's room, unseen and out of reach: the other buttons stand where every card has them, and the card keeps
             its height when its skin is turned on. */
          <span className="btn small ghost skin-apply-room" aria-hidden="true">
            {words.apply}
          </span>
        ) : (
          <button className="btn small ghost" type="button" aria-label={`${words.apply}: ${card.name}`} data-focus-skin={card.id} onClick={onApply}>
            {words.apply}
          </button>
        )}
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
      <h5 id={id}>{t.skins.guide}</h5>
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

/* The built-in skins in the order of the registry, then a person's own in the order they were added. */
function catalogCards(t: Messages, language: Language, custom: readonly CustomSkin[]): Card[] {
  return [
    ...BUILTIN_SKINS.map(skin => ({ id: skin.id, look: skin, name: t.skins.names[skin.id], desc: t.skins.descs[skin.id], own: false, file: () => builtinFile(skin, builtinNames(skin.id)) })),
    ...custom.map(({ id, skin }) => ({ id, look: ownLook(skin), name: nameIn(skin.name, language), desc: t.skins.ownDesc, own: true, file: () => skin })),
  ];
}

const failure = (t: Messages, text: string): Notice => ({ tone: 'alert', title: t.skins.addFailed, text });

/* Keeps a skin read from a file under a name no other card has, and says how it went: added, or why not. */
function keepRead(t: Messages, language: Language, read: Skin | Problem): Notice {
  if ('code' in read) return failure(t, problemText(t, read));
  const taken = [...BUILTIN_SKINS.map(builtin => builtinNames(builtin.id)), ...skinsState().custom.map(entry => entry.skin.name)];
  const named = { ...read, name: uniqueName(read.name, taken) };
  const added = addSkin(named);
  if (added.ok) return { tone: 'status', text: t.skins.added(nameIn(named.name, language)) };
  return failure(t, added.reason === 'full' ? t.skins.full(COLLECTION_LIMIT) : t.skins.notKept);
}

/* Removes one's own skin and says so with Undo; focus goes to the next card, else the one before, else Add from file. */
function removeCard(t: Messages, cards: readonly Card[], card: Card): { notice: Notice; focus: string } | null {
  const removal = removeSkin(card.id);
  if (!removal) return null;
  const fellBack = removal.wasOn ? ` ${t.skins.nowOn(t.skins.names[DEFAULT_SKIN])}` : '';
  const at = cards.indexOf(card);
  return { notice: { tone: 'status', text: `${t.skins.removed(card.name)}${fellBack}`, removal }, focus: (cards[at + 1] ?? cards[at - 1])?.id ?? '' };
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

function download(t: Messages, card: Card, say: (notice: Notice) => void): void {
  try {
    saveFile(card);
  } catch {
    say({ tone: 'alert', text: t.skins.downloadFailed(card.name) });
  }
}

/* Focus after the catalog has drawn again: the Apply of the card named, or its state when it is on, else Add from file. */
function moveFocus(root: HTMLElement | null, to: string): void {
  const target = root?.querySelector<HTMLElement>(`[data-focus-skin="${to}"]`) ?? root?.querySelector<HTMLElement>('[data-add]');
  target?.focus();
}

type Talk = { say: (notice: Notice) => void; focusOn: (id: string) => void };

/* Add from file: one file at a time, the button kept in place and its label saying so while the file is read. */
function AddFromFile({ say, focusOn }: Talk) {
  const t = useT();
  const { language } = useLanguage();
  const [reading, setReading] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  async function load(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    /* The same file can be picked again after it is fixed; no file picked changes nothing. */
    input.value = '';
    if (!file) return;
    setReading(true);
    say({ tone: 'busy', text: t.skins.busy });
    const read = await readSkin(file);
    setReading(false);
    say(keepRead(t, language, read));
    focusOn('');
  }

  return (
    <div className="skins-add">
      <button className="btn small" type="button" data-add disabled={reading} aria-busy={reading || undefined} onClick={() => picker.current?.click()}>
        <SwapLabel first={t.skins.add} second={t.skins.loading} showSecond={reading} />
      </button>
      <input ref={picker} type="file" accept=".json,application/json" hidden onChange={event => void load(event)} />
    </div>
  );
}

type CatalogProps = { cards: readonly Card[]; active: string; onApply: (card: Card) => void; onDownload: (card: Card) => void; onRemove: (card: Card) => void };

function StoreFilters({ filter, onSelect }: { filter: StoreFilter; onSelect: (next: StoreFilter) => void }) {
  const t = useT();
  return (
    <div className="skins-filters" role="group" aria-label={t.skins.filterLabel}>
      {STORE_FILTERS.map(kind => (
        <button key={kind} className={`btn small ghost${filter === kind ? ' on' : ''}`} type="button" aria-pressed={filter === kind} onClick={() => onSelect(kind)}>
          {t.skins.filters[kind]}
        </button>
      ))}
    </div>
  );
}

function CatalogEmpty({ custom }: { custom: boolean }) {
  const t = useT();
  return (
    <div className="skins-empty">
      <p className="skins-empty-title">{custom ? t.skins.empty : t.skins.emptyFilter}</p>
      {custom && <p className="muted">{t.skins.emptyHint}</p>}
    </div>
  );
}

function Catalog({ cards, active, onApply, onDownload, onRemove }: CatalogProps) {
  const t = useT();
  const id = useId();
  const [filter, setFilter] = useState<StoreFilter>('all');
  const shown = cards.filter(card => matchesFilter(card, filter));
  const showOwnEmpty = filter === 'all' && !cards.some(card => card.own);
  return (
    <section className="skins-catalog" aria-labelledby={id}>
      <div className="skins-catalog-head">
        <h5 id={id}>{t.skins.catalog}</h5>
        <p className="muted">{t.skins.catalogHint}</p>
      </div>
      <StoreFilters filter={filter} onSelect={setFilter} />
      {shown.length > 0 ? (
        <div className="skin-wrap">
          <ul className="skin-cards">
            {shown.map(card => (
              <SkinCard key={card.id} card={card} on={card.id === active} onApply={() => onApply(card)} onDownload={() => onDownload(card)} onRemove={() => onRemove(card)} />
            ))}
          </ul>
        </div>
      ) : (
        <CatalogEmpty custom={filter === 'custom'} />
      )}
      {showOwnEmpty && <CatalogEmpty custom />}
    </section>
  );
}

function MapGrainOption({ shown }: { shown: boolean }) {
  const t = useT();
  const grain = useMapGrain();
  if (!shown) return null;
  return (
    <div className="skins-grain">
      <label className="check">
        <input type="checkbox" checked={grain} onChange={event => setMapGrain(event.target.checked)} />
        <span>{t.skins.grainToggle}</span>
      </label>
      <p className="muted skins-grain-hint">{t.skins.grainHint}</p>
    </div>
  );
}

export function Themes({ onCompanyTheme }: { onCompanyTheme?: (theme: string) => void } = {}) {
  const t = useT();
  const { language } = useLanguage();
  const { active, custom } = useSkins();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  /* Where focus goes once the catalog has drawn again: the Apply of a card, or Add from file. */
  const focusTo = useRef<string | null>(null);
  const headingId = useId();

  useEffect(() => {
    if (focusTo.current === null) return;
    moveFocus(root.current, focusTo.current);
    focusTo.current = null;
  });

  const cards = catalogCards(t, language, custom);
  const activeCard = cards.find(card => card.id === active);
  const focusOn = (id: string) => {
    focusTo.current = id;
  };

  async function apply(card: Card) {
    if (card.id === active || saving) return;
    setSaving(true);
    try {
      const serverTheme = card.own ? DEFAULT_SKIN : card.id;
      await api.put('/api/world/theme', { theme: serverTheme });
      if (!chooseSkin(card.id)) return;
      if (!card.own) onCompanyTheme?.(serverTheme);
      setNotice({ tone: 'status', text: t.skins.nowOn(card.name) });
      focusOn(card.id);
    } catch (err) {
      setNotice({ tone: 'alert', text: errorText(t, err) });
    } finally {
      setSaving(false);
    }
  }

  function remove(card: Card) {
    const removed = removeCard(t, cards, card);
    if (!removed) return;
    setNotice(removed.notice);
    focusOn(removed.focus);
  }

  function undo(removal: Removal) {
    const back = restoreSkin(removal);
    if (!back) return setNotice(failure(t, t.skins.notKept));
    setNotice({ tone: 'status', text: t.skins.restored(nameIn(back.skin.name, language)) });
    focusOn(back.id);
  }

  return (
    <div className="skins" ref={root}>
      <div className="skins-head">
        <div className="skins-intro">
          <div className="skins-title-row">
            <ThemeShopIcon />
            <h4 id={headingId}>{t.skins.title}</h4>
          </div>
          <p>{t.skins.desc}</p>
          <p className="muted">{t.skins.local}</p>
        </div>
        <AddFromFile say={setNotice} focusOn={focusOn} />
      </div>
      {notice && <NoticeBar notice={notice} onUndo={undo} />}
      <Catalog cards={cards} active={active} onApply={card => void apply(card)} onDownload={card => download(t, card, setNotice)} onRemove={remove} />
      <MapGrainOption shown={activeCard?.look.surface === 'papyrus'} />
      <Guide />
    </div>
  );
}
