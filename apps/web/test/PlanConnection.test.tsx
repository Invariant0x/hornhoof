import { SIGNIN_ERRORS } from '@hornhoof/protocol/signin';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { passedWords } from '../src/ui/PlanConnection';
import { Stalled, Waiting } from '../src/ui/Waiting';

describe('the time since the sign-in code', () => {
  it.each([
    [0, '0 s', '0 с'],
    [59_999, '59 s', '59 с'],
    [60_000, '1 min 0 s', '1 мин 0 с'],
    [65_400, '1 min 5 s', '1 мин 5 с'],
    [61 * 60_000, '61 min 0 s', '61 мин 0 с'],
  ])('reads %i ms as whole seconds, then minutes and seconds', (ms, inEnglish, inRussian) => {
    expect(passedWords(en, ms)).toBe(inEnglish);
    expect(passedWords(ru, ms)).toBe(inRussian);
  });

  it('reads a clock a little behind the server as no time at all', () => {
    expect(passedWords(en, -1500)).toBe('0 s');
  });

  it('says every connection step and the overlong state in plain words in each language', () => {
    for (const t of [en, ru]) {
      for (const words of Object.values(t.subs.connection.steps)) expect(words).toMatch(/^\S.*\S$/);
      expect(t.common.tooLong.length).toBeGreaterThan(0);
      expect(JSON.stringify(t.subs.connection)).not.toMatch(/[—–]/);
    }
    expect(en.common.tooLong).toBe('Taking longer than usual');
    expect(ru.common.tooLong).toBe('Дольше обычного');
    expect(en.subs.signInErrors.signedOut).toBe(SIGNIN_ERRORS.signedOut);
  });
});

describe('something under way, and something stalled', () => {
  it('shows a turning mark only while something is under way, with what it is at as a status', () => {
    const { container } = render(<Waiting what="Getting the models" detail="1 min 5 s since the code" />);
    expect(screen.getByRole('status').textContent).toBe('Getting the models1 min 5 s since the code');
    expect(container.querySelectorAll('.waiting-mark')).toHaveLength(1);
  });

  it('says why it stalled as an alert, then what to do, with Try again first and no mark', () => {
    const { container } = render(<Stalled tone="late" reason="Taking longer than usual" next="Try again, or stop." retry={{ text: 'Try again', label: 'Try connecting Codex again', run: () => {} }} cancel={{ text: 'Stop', run: () => {} }} />);
    expect(screen.getByRole('alert').textContent).toBe('Taking longer than usual');
    expect(screen.getAllByRole('button').map(b => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Try connecting Codex again', 'Stop']);
    expect(container.querySelectorAll('.waiting-mark')).toHaveLength(0);
  });
});
