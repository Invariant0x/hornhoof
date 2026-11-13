import { useId, useState, useSyncExternalStore, type ChangeEvent, type CSSProperties, type ReactNode } from 'react';
import { useT } from '../i18n';
import type { Messages } from '../i18n/en';
import { COLLECTION_LIMIT, type CustomSkin } from '../skins/collection';
import { BUILTIN_SKINS, type BuiltinSkin, type BuiltinSkinId } from '../skins/registry';
import { declarations, lookOnly, type Skin, type SkinLook } from '../skins/roles';
import { chooseSkin, forgetSkin, keepSkins, skinsState, subscribeSkins } from '../skins/store';
import { parseSkin, SKIN_FILE_LIMIT, skinText, type SkinError } from '../skins/validate';

/* The Themes section of a person's settings: a card for every built-in theme and every one of their own, one click to
   turn one on, files to load, any theme to download as a sample, and the guide to making one. Anyone signed in has it:
   what it changes stays in this browser. */

type Problem = { file: string; code: SkinError['code'] | 'read_failed'; key?: string };
type Outcome = { added: string[]; over: number; kept: boolean; problems: Problem[] };

const useSkins = () => useSyncExternalStore(subscribeSkins, skinsState);

/* The name people see: a built-in skin's in the language of the page, one's own as its file names it. */
function skinName(t: Messages, id: string, custom: readonly CustomSkin[]): string {
  return custom.find(entry => entry.id === id)?.skin.name ?? t.skins.names[id as BuiltinSkinId];
}

/* The tokens of a skin on its own preview only, so each card shows its theme in the same drawing. */
const previewStyle = (look: SkinLook) => Object.fromEntries(declarations(look).filter(([property]) => property.startsWith('--'))) as CSSProperties;

const fileLink = (skin: Skin) => `data:application/json;charset=utf-8,${encodeURIComponent(skinText(skin))}`;

/* One row of the account menu: where the themes are, and which one is on. */
export function ThemesMenuItem({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  const { active, custom } = useSkins();
  const name = skinName(t, active, custom);
  return (
    <button className="menu-link" type="button" aria-label={t.skins.menu(name)} onClick={onOpen}>
      <span>{t.skins.title}</span>
      <b>{name}</b>
    </button>
  );
}

async function readSkin(file: File): Promise<Skin | Omit<Problem, 'file'>> {
  if (file.size > SKIN_FILE_LIMIT) return { code: 'too_large' };
  try {
    const parsed = parseSkin(await file.text());
    return parsed.ok ? parsed.skin : parsed.error;
  } catch {
    return { code: 'read_failed' };
  }
}

/* Every file in the order picked: the skins that passed, and what is wrong with each one that did not. */
async function readFiles(files: File[]): Promise<{ skins: Skin[]; problems: Problem[] }> {
  const skins: Skin[] = [];
  const problems: Problem[] = [];
  for (const file of files) {
    const read = await readSkin(file);
    if ('code' in read) problems.push({ file: file.name, ...read });
    else skins.push(read);
  }
  return { skins, problems };
}

function Preview({ look }: { look: SkinLook }) {
  return (
    <span className="skin-swatch" style={previewStyle(look)} aria-hidden="true">
      <span className="skin-panel">
        <span className="skin-aa">Aa</span>
        <span className="skin-bar" />
      </span>
      <span className="skin-dots">
        <i className="accent" />
        <i className="success" />
        <i className="warning" />
        <i className="attention" />
      </span>
      <span className="skin-btn" />
    </span>
  );
}

type CardProps = { id: string; look: SkinLook; name: string; own: boolean; on: boolean };

function SkinCard({ id, look, name, own, on }: CardProps) {
  const t = useT();
  const nameId = useId();
  const metaId = useId();
  const [asking, setAsking] = useState(false);
  const kind = t.skins.kind[look.scheme];
  return (
    <li className="skin-card">
      <button className="skin-pick" type="button" aria-pressed={on} aria-labelledby={nameId} aria-describedby={metaId} onClick={() => chooseSkin(id)}>
        <Preview look={look} />
      </button>
      <h4 id={nameId} className="skin-name">{name}</h4>
      <p id={metaId} className="skin-meta">{own ? t.skins.own(kind) : t.skins.builtin(kind)}</p>
      {asking ? (
        <div className="skin-ask">
          <p>{t.skins.removeAsk(name)}</p>
          <div className="entry-actions">
            <button className="btn small" type="button" onClick={() => forgetSkin(id)}>{t.skins.yesRemove}</button>
            <button className="btn small ghost" type="button" onClick={() => setAsking(false)}>{t.skins.keep}</button>
          </div>
        </div>
      ) : (
        <div className="entry-actions">
          <a className="btn small ghost" href={fileLink({ ...lookOnly(look), name })} download={`hornhoof-skin-${id}.json`} aria-label={t.skins.downloadLabel(name)}>
            {t.skins.download}
          </a>
          {own && (
            <button className="btn small ghost" type="button" aria-label={t.skins.removeLabel(name)} onClick={() => setAsking(true)}>
              {t.skins.remove}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function Cards({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="skins-part" aria-labelledby={id}>
      <h3 id={id}>{label}</h3>
      {children}
    </section>
  );
}

/* What the last load did: the skins added, and in plain words each file refused and why. */
function LoadOutcome({ outcome }: { outcome: Outcome }) {
  const t = useT();
  const notes = [
    ...outcome.problems.map(problem => t.skins.fileProblem(problem.file, t.skins.errors[problem.code](problem.key ?? ''))),
    ...(outcome.over ? [t.skins.full(outcome.over, COLLECTION_LIMIT)] : []),
    ...(outcome.kept ? [] : [t.skins.notKept]),
  ];
  return (
    <>
      {outcome.added.length > 0 && <p className="skins-added" role="status">{t.skins.added(outcome.added.join(', '))}</p>}
      {notes.length > 0 && (
        <div className="alert" role="alert">
          <ul className="skins-problems">
            {notes.map((note, at) => <li key={at}>{note}</li>)}
          </ul>
        </div>
      )}
    </>
  );
}

function Guide() {
  const t = useT();
  const id = useId();
  const words = t.skins.guide;
  return (
    <section className="skins-guide" aria-labelledby={id}>
      <h3 id={id}>{words.title}</h3>
      <h4>{words.sampleTitle}</h4>
      <ol>{words.sample.map(step => <li key={step}>{step}</li>)}</ol>
      <h4>{words.aiTitle}</h4>
      <p>{words.ai}</p>
      <p className="skins-prompt">{words.prompt}</p>
      <p>{words.aiCheck}</p>
      <h4>{words.fieldsTitle}</h4>
      <ul>{words.fields.map(field => <li key={field}>{field}</li>)}</ul>
      <p>{words.safety}</p>
      <h4>{words.layoutTitle}</h4>
      <p>{words.layout}</p>
    </section>
  );
}

export function Themes() {
  const t = useT();
  const { active, custom } = useSkins();
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function load(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = [...(input.files ?? [])];
    /* The same files can be picked again after they are fixed. */
    input.value = '';
    if (!files.length) return;
    const { skins, problems } = await readFiles(files);
    const { added, over, kept } = keepSkins(skins);
    setOutcome({ added: added.map(entry => entry.skin.name), over, kept, problems });
  }

  const card = (skin: BuiltinSkin) => <SkinCard key={skin.id} id={skin.id} look={skin} name={t.skins.names[skin.id]} own={false} on={active === skin.id} />;
  return (
    <div className="skins">
      <p className="skins-now">{t.skins.now(skinName(t, active, custom))}</p>
      <p>{t.skins.about}</p>
      <Cards label={t.skins.builtins}>
        <ul className="skin-cards" aria-label={t.skins.builtins}>{BUILTIN_SKINS.map(card)}</ul>
      </Cards>
      <Cards label={t.skins.collection}>
        <div className="entry-actions skins-load">
          <label className="btn small">
            <input className="sr" type="file" multiple accept=".json,application/json" onChange={event => void load(event)} />
            {t.skins.load}
          </label>
        </div>
        {outcome && <LoadOutcome outcome={outcome} />}
        {custom.length > 0 ? (
          <ul className="skin-cards" aria-label={t.skins.collection}>
            {custom.map(entry => <SkinCard key={entry.id} id={entry.id} look={entry.skin} name={entry.skin.name} own on={active === entry.id} />)}
          </ul>
        ) : (
          <p className="skins-empty">{t.skins.empty}</p>
        )}
      </Cards>
      <Guide />
    </div>
  );
}
