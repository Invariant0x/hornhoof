import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { cutLine } from '../src/restarts';

describe('a server restart in the employee card and task log', () => {
  it.each([
    { language: 'English', messages: en, expected: 'The built-in node, 10:30. The Hornhoof server started again. Turn aaaaaaaa.' },
    { language: 'Russian', messages: ru, expected: 'Встроенная нода, 10:30. Сервер Hornhoof перезапустился. Ход aaaaaaaa.' },
  ])('names the cause in $language', ({ messages, expected }) => {
    expect(cutLine(messages, { node: null, cause: 'server', job: 'aaaaaaaa-0000-4000-8000-000000000001' }, '10:30')).toBe(expected);
  });
});
