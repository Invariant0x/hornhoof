import { render, screen } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { CommandLifetime } from '../src/ui/CommandBox';

describe('the time left to use an install command', () => {
  it.each([
    ['en', 1, 'Valid for 1 more minute.'], ['en', 35, 'Valid for 35 more minutes.'],
    ['en', 60, 'Valid for 1 more hour.'], ['en', 120, 'Valid for 2 more hours.'],
    ['ru', 35, 'Действует еще 35 мин.'], ['ru', 60, 'Действует еще 1 ч.'],
  ])('%s at %s minutes', (language, minutes, text) => {
    localStorage.setItem('hh-lang', language);
    onTestFinished(() => { localStorage.clear(); });
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    vi.setSystemTime(new Date('2026-11-03T10:00:00Z'));
    render(<LanguageProvider><CommandLifetime expiresAt={new Date(Date.now() + Number(minutes) * 60_000).toISOString()} /></LanguageProvider>);
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});
