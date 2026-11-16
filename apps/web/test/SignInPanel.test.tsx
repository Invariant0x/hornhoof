import { describe, expect, it } from 'vitest';
import { SIGNIN_ERRORS } from '@hornhoof/protocol/signin';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { signInError } from '../src/ui/SignInPanel';

const LINE = 'Error: claude native binary not installed.';

describe('why a sign-in did not finish, in the owner\'s words', () => {
  it.each([
    [en, `The sign-in ended with code 1, so nothing changed. The program said: ${LINE}`],
    [ru, `Вход завершился с кодом 1, ничего не изменилось. Программа написала: ${LINE}`],
  ])('shows the code and the last line the program said instead of the plain words', (t, shown) => {
    expect(signInError(t, { error: SIGNIN_ERRORS.unfinished, code: 1, line: LINE })).toBe(shown);
  });

  it.each([
    [en, 'The sign-in ended before it finished, so nothing changed.'],
    [ru, 'Вход закончился раньше времени, ничего не изменилось.'],
  ])('keeps the plain words when the machine gave no line', (t, shown) => {
    expect(signInError(t, { error: SIGNIN_ERRORS.unfinished, code: 1, line: null })).toBe(shown);
    expect(signInError(t, { error: SIGNIN_ERRORS.unfinished })).toBe(shown);
  });

  it('says a program that ended with no code it knows without one', () => {
    expect(signInError(en, { error: SIGNIN_ERRORS.unfinished, code: null, line: LINE })).toBe(`The sign-in ended, so nothing changed. The program said: ${LINE}`);
  });
});
