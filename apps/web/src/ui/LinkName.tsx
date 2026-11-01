import { isLinkName, randomLinkName } from '@hornhoof/protocol/link';
import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n';

export type NameCheck = { name: string; free: boolean; reason?: 'taken' | 'reserved' | 'invalid' };

/* What is known about the name typed: nothing yet, not a name a link can have, being checked, free, taken or kept
   for Hornhoof, or not known because the check failed. */
export type NameState = 'empty' | 'invalid' | 'checking' | 'free' | 'taken' | 'reserved' | 'unknown';

/* A name the person may not go on with. */
export const blocks = (state: NameState) => state === 'empty' || state === 'invalid' || state === 'taken' || state === 'reserved';

type Props = {
  name: string;
  onName: (name: string) => void;
  /* What the link's address ends in, like hornhoof.org. */
  domain: string;
  /* Asks Hornhoof's own server whether the name is free; the browser never asks the relay. */
  check: (name: string) => Promise<NameCheck>;
  onState?: (state: NameState) => void;
  problem?: string;
};

/* Waits this long after the last key before asking, so typing a name asks once. */
const PAUSE_MS = 350;

/* The name of a public link like acme.hornhoof.org: the field, a button for a long random name, and whether the name is
   free, asked while it is typed. */
export function LinkName({ name, onName, domain, check, onState, problem }: Props) {
  const t = useT();
  const id = useId();
  const [state, setState] = useState<NameState>('empty');
  const [random, setRandom] = useState('');
  const asking = useRef(check);
  asking.current = check;
  const told = useRef(onState);
  told.current = onState;

  useEffect(() => {
    const now: NameState = !name ? 'empty' : isLinkName(name) ? 'checking' : 'invalid';
    setState(now);
    told.current?.(now);
    if (now !== 'checking') return;
    let current = true;
    const timer = setTimeout(() => {
      asking
        .current(name)
        .then(found => (found.free ? 'free' : (found.reason ?? 'taken')) as NameState)
        .catch((): NameState => 'unknown')
        .then(next => {
          if (!current) return;
          setState(next === 'invalid' ? 'invalid' : next);
          told.current?.(next);
        });
    }, PAUSE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [name]);

  const said = {
    empty: t.link.empty,
    invalid: t.link.invalid,
    checking: t.link.checking,
    free: t.link.free(`${name}.${domain}`),
    taken: t.link.taken,
    reserved: t.link.reserved,
    unknown: t.link.unknown,
  }[state];
  const bad = problem || (blocks(state) && state !== 'empty' ? said : '');

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
      <button
        className="btn small ghost"
        type="button"
        onClick={() => {
          const next = randomLinkName();
          setRandom(next);
          onName(next);
        }}
      >
        {t.link.random}
      </button>
    </div>
  );
}
