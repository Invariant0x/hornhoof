import { isLinkName, randomLinkName } from '@hornhoof/protocol/link';
import { useEffect, useId, useRef, useState } from 'react';
import { useT, type Messages } from '../i18n';

export type NameCheck = { name: string; free: boolean; reason?: 'taken' | 'reserved' | 'invalid' };

/* What is known about the name typed: nothing yet, not a name a link can have, the link the company has now, being
   checked, free, taken or kept for Hornhoof, or not known because the check failed. */
export type NameState = 'empty' | 'invalid' | 'current' | 'checking' | 'free' | 'taken' | 'reserved' | 'unknown';

/* A name the person may not go on with. */
export const blocks = (state: NameState) => state === 'empty' || state === 'invalid' || state === 'current' || state === 'taken' || state === 'reserved';

type Props = {
  name: string;
  onName: (name: string) => void;
  /* What the link's address ends in, like hornhoof.org. */
  domain: string;
  /* Asks Hornhoof's own server whether the name is free; the browser never asks the relay. */
  check: (name: string) => Promise<NameCheck>;
  onState?: (state: NameState) => void;
  problem?: string;
  /* The name of the link the company has now, which is not asked about. */
  current?: string;
  /* Starts on a long random name when the field is empty as it mounts. */
  startRandom?: boolean;
};

/* Waits this long after the last key before asking, so typing a name asks once. */
const PAUSE_MS = 350;

/* What is known about a name before anyone is asked: nothing, the link now, a name a link can have, or one it cannot. */
const nameStateOf = (name: string, current?: string): NameState =>
  !name ? 'empty' : name === current ? 'current' : isLinkName(name) ? 'checking' : 'invalid';

const answerState = (found: NameCheck): NameState => (found.free ? 'free' : (found.reason ?? 'taken'));

/* Asks about the name after the pause and tells the answer, 'unknown' when the check fails; the returned function drops a
   pending ask, so a name typed over is never answered. */
function askAfterPause(ask: (name: string) => Promise<NameCheck>, name: string, told: (state: NameState) => void): () => void {
  let live = true;
  const timer = setTimeout(() => {
    void ask(name)
      .then(answerState)
      .catch((): NameState => 'unknown')
      .then(next => live && told(next));
  }, PAUSE_MS);
  return () => {
    live = false;
    clearTimeout(timer);
  };
}

/* The state of the name as it is typed, which the parent hears too. */
function useNameState(name: string, current: string | undefined, check: Props['check'], onState: Props['onState']): NameState {
  const [state, setState] = useState<NameState>('empty');
  const asking = useRef(check);
  asking.current = check;
  const told = useRef(onState);
  told.current = onState;

  useEffect(() => {
    const say = (next: NameState) => {
      setState(next);
      told.current?.(next);
    };
    const now = nameStateOf(name, current);
    say(now);
    if (now === 'checking') return askAfterPause(n => asking.current(n), name, say);
  }, [name, current]);
  return state;
}

/* The random name the field gave, to know whether the name in it is still that one, and the click that gives a new one;
   with startRandom an empty field starts with one as it mounts. */
function useRandomName(name: string, onName: (name: string) => void, startRandom: boolean | undefined): [string, () => void] {
  const [random, setRandom] = useState('');
  const named = useRef(onName);
  named.current = onName;
  const take = () => {
    const next = randomLinkName();
    setRandom(next);
    named.current(next);
  };
  useEffect(() => {
    // Only as the field mounts: a name emptied later is the person's own.
    if (startRandom && !name) take();
  }, []);
  return [random, take];
}

const sayName = (t: Messages, state: NameState, address: string): string =>
  ({
    empty: t.link.empty,
    invalid: t.link.invalid,
    current: t.link.current,
    checking: t.link.checking,
    free: t.link.free(address),
    taken: t.link.taken,
    reserved: t.link.reserved,
    unknown: t.link.unknown,
  })[state];

/* What is wrong with the name, if anything: the parent's problem, or what a state that stops the person says. */
const trouble = (problem: string | undefined, state: NameState, said: string): string =>
  problem || (blocks(state) && state !== 'empty' && state !== 'current' ? said : '');

/* The name of a public link like acme.hornhoof.org: the field, a button for a long random name, and whether the name is
   free, asked while it is typed. */
export function LinkName({ name, onName, domain, check, onState, problem, current, startRandom }: Props) {
  const t = useT();
  const id = useId();
  const state = useNameState(name, current, check, onState);
  const [random, takeRandom] = useRandomName(name, onName, startRandom);
  const said = sayName(t, state, `${name}.${domain}`);
  const bad = trouble(problem, state, said);

  return (
    <div className="field link-name">
      <label htmlFor={id}>{t.link.label}</label>
      <div className="link-input">
        <input
          id={id}
          value={name}
          onChange={e => onName(e.target.value.trim().toLowerCase())}
          maxLength={63}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby={`${id}-note ${id}-safety`}
          aria-invalid={bad ? true : undefined}
        />
        <span className="link-domain">.{domain}</span>
      </div>
      <span id={`${id}-note`} className={bad ? 'bad' : 'hint'} aria-live="polite">{problem || said}</span>
      <span id={`${id}-safety`} className="hint">{name && name === random ? t.link.hardToGuess : t.link.guessable}</span>
      <button className="btn small ghost" type="button" onClick={takeRandom}>{t.link.random}</button>
    </div>
  );
}
