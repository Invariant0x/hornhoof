import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { effortOfTurn } from '../src/modules/conversation/turn-effort.js';
import { loadTemplates } from '../src/modules/templates/load.js';

const ctx = { templates: loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url))) };
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const reviewer = { kind: 'worker' as const, roleKey: 'DEV-REV', effort: null };

describe('configured effort at program start', () => {
  it.each(LEVELS)('honors the supported card choice %s', effort => {
    expect(effortOfTurn(ctx, { ...reviewer, effort }, LEVELS)).toBe(effort);
  });

  it('uses the current role default and the orchestrator default', () => {
    expect(effortOfTurn(ctx, reviewer, LEVELS)).toBe('xhigh');
    expect(effortOfTurn(ctx, { kind: 'orchestrator', roleKey: null, effort: null }, LEVELS)).toBe('xhigh');
  });

  it('fits a role default to supported levels when the card choice is unavailable', () => {
    expect(effortOfTurn(ctx, { ...reviewer, effort: 'max' }, ['low', 'high'])).toBe('high');
    expect(effortOfTurn(ctx, reviewer, ['low'])).toBe('low');
  });

  it('leaves a program to choose without a role or known model levels', () => {
    expect(effortOfTurn(ctx, reviewer, [])).toBeNull();
    expect(effortOfTurn(ctx, { ...reviewer, roleKey: null }, LEVELS)).toBeNull();
  });
});
