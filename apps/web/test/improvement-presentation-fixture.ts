import type { ImprovementPresentation } from '../src/types';

export const PRESENTATION = {
  schemaVersion: 1,
  state: 'ready',
  sourceRevision: 'rev-1',
  updatedAt: '2026-11-01T00:01:00.000Z',
  locales: {
    en: {
      title: 'Make repeated checks easier to understand',
      observation: 'Two synthetic checks produced the same unclear message.',
      impact: 'A reviewer cannot tell whether a new check failed.',
      change: 'Label each result with its actual run.',
      expectedResult: 'A reviewer can distinguish a new failure from an old message.',
      facts: [{ text: 'The fixture contains two synthetic messages.', evidenceIds: ['ev-1'] }],
      hypotheses: ['The messages may share a display label.'],
      unknowns: ['The production cause is not evaluated by this fixture.'],
    },
    ru: {
      title: 'Сделать повторные проверки понятнее',
      observation: 'Две синтетические проверки показали одинаковое непонятное сообщение.',
      impact: 'Проверяющий не может понять, была ли ошибка у новой проверки.',
      change: 'Подписывать каждый результат по фактическому запуску.',
      expectedResult: 'Проверяющий сможет отличить новую ошибку от старого сообщения.',
      facts: [{ text: 'Фикстура содержит два синтетических сообщения.', evidenceIds: ['ev-1'] }],
      hypotheses: ['Возможно, сообщения используют одну подпись.'],
      unknowns: ['Причина в реальной системе этой фикстурой не проверяется.'],
    },
  },
} satisfies ImprovementPresentation;

export const EVIDENCE = {
  id: 'ev-1',
  sourceRef: 'synthetic-check-log',
  at: '2026-11-01T00:00:00.000Z',
  author: 'Fixture collector',
  quote: 'Two synthetic messages',
  url: 'https://example.test/evidence/ev-1',
};
