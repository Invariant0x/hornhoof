import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { WorldLoadingScreen, type WorldLoadProgress } from '../src/screens/WorldLoadingScreen';

/* #1947 item 1: the world's loading screen tells honest progress by the real bytes of the pictures and the ground
   pieces baked, step by step (pictures, map, ground), in English and Russian, with no endless spinner. */

const MB = 1024 * 1024;

function show(lang: 'en' | 'ru', progress: WorldLoadProgress) {
  localStorage.setItem('hh-lang', lang);
  return render(
    <LanguageProvider>
      <WorldLoadingScreen progress={progress} />
    </LanguageProvider>,
  );
}

afterEach(() => localStorage.clear());

describe('World loading screen (#1947)', () => {
  it('shows the pictures step with its real bytes, and the steps after it still waiting', () => {
    show('en', { step: 'art', loadedBytes: 3.2 * MB, totalBytes: 17.5 * MB, bakedChunks: 0, totalChunks: 0 });
    const box = screen.getByRole('status');
    expect(within(box).getByRole('heading').textContent).toBe('The world is loading');
    const bars = within(box).getAllByRole('progressbar');
    expect(bars.map(b => b.getAttribute('aria-label'))).toEqual(['Pictures', 'City and map', 'Ground']);
    expect(bars[0]!.getAttribute('aria-valuenow')).toBe(String(Math.round(3.2 * MB)));
    expect(bars[0]!.getAttribute('aria-valuemax')).toBe(String(Math.round(17.5 * MB)));
    expect(bars[0]!.getAttribute('aria-valuetext')).toBe('3.2 of 17.5 MB');
    expect(bars[1]!.getAttribute('aria-valuetext')).toBe('Waiting');
    expect(bars[2]!.getAttribute('aria-valuetext')).toBe('Waiting');
    expect(box.textContent).toContain('3.2 of 17.5 MB');
  });

  it('counts the ground pieces once the pictures and the map are done, in Russian', () => {
    show('ru', { step: 'bake', loadedBytes: 17.5 * MB, totalBytes: 17.5 * MB, bakedChunks: 7, totalChunks: 20 });
    const box = screen.getByRole('status');
    expect(within(box).getByRole('heading').textContent).toBe('Мир загружается');
    const bars = within(box).getAllByRole('progressbar');
    expect(bars.map(b => b.getAttribute('aria-label'))).toEqual(['Картинки', 'Город и карта', 'Земля']);
    expect(bars.map(b => b.getAttribute('aria-valuetext'))).toEqual(['Готово', 'Готово', '7 из 20 участков']);
    expect(bars[2]!.getAttribute('aria-valuenow')).toBe('7');
    expect(bars[2]!.getAttribute('aria-valuemax')).toBe('20');
  });

  it('marks the map step as the one going on while the city is laid out', () => {
    show('en', { step: 'map', loadedBytes: 1 * MB, totalBytes: 1 * MB, bakedChunks: 0, totalChunks: 0 });
    const bars = screen.getAllByRole('progressbar');
    expect(bars.map(b => b.getAttribute('aria-valuetext'))).toEqual(['Done', 'Now', 'Waiting']);
  });
});
