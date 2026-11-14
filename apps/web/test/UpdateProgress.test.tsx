import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import type { UpdateStep } from '../src/types';
import { UpdateProgress } from '../src/ui/UpdateProgress';

afterEach(() => localStorage.clear());

const shown = (step: UpdateStep, language = 'en') => {
  localStorage.setItem('hh-lang', language);
  const view = render(<LanguageProvider><UpdateProgress version="0.19.0" step={step} /></LanguageProvider>);
  const bar = screen.getByRole('progressbar');
  const said = [bar.getAttribute('aria-valuetext'), bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax'), bar.querySelectorAll('i').length];
  view.unmount();
  return said;
};

describe('the progress of an update', () => {
  it('counts the promise as a step', () => {
    expect(shown('promise')).toEqual(['Step 2 of 5: asking the copies to wait', '1', '5', 5]);
    expect(shown('promise', 'ru')).toEqual(['Шаг 2 из 5: прошу копии подождать', '1', '5', 5]);
    /* The steps around it, in the updater's order. */
    expect([shown('pull')[0], shown('backup')[0], shown('install')[0], shown('health')[0]]).toEqual([
      'Step 1 of 5: downloading', 'Step 3 of 5: saving the database', 'Step 4 of 5: installing', 'Step 5 of 5: waiting for the new server',
    ]);
  });
});
