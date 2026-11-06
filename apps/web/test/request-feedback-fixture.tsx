import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import type { TaskPlace, WaitingRequest } from '../src/types';
import type { Requests } from '../src/ui/Requests';

export function renderIn(lang: 'en' | 'ru', node: ReactNode) {
  localStorage.setItem('hh-lang', lang);
  return render(<LanguageProvider>{node}</LanguageProvider>);
}

export function requestProps(request: WaitingRequest, overrides: Partial<Parameters<typeof Requests>[0]> = {}) {
  return {
    requests: [request],
    onChanged: vi.fn(),
    onOpenTask: vi.fn(),
    onOpenAgent: vi.fn(),
    placeName: (p: TaskPlace) => p?.name ?? '',
    ...overrides,
  };
}
