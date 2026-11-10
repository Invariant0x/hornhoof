import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import type { Employee } from '../src/types';
import { Chip } from '../src/ui/Chip';

const employee = (over: Partial<Employee>): Employee =>
  ({ id: 'e1', name: 'Mira', on: true, status: 'idle', provider: null, model: '', modelName: null, effort: null, task: null, timer: null, context: null, program: null, alarm: null, held: null, retry: null, ...over }) as Employee;
const chip = (e: Employee) => render(<LanguageProvider><Chip e={e} x={0} y={0} on={false} flash={false} onOpen={() => {}} /></LanguageProvider>);

describe('an employee chip', () => {
  it('is grey and asks for a subscription while its employee has none', () => {
    const { container } = chip(employee({ status: 'off' }));
    expect(container.querySelector('.sslot')!.className).toContain('no-plan');
    expect(screen.getByText('Assign a subscription to start')).toBeInTheDocument();
  });

  it('is not grey for an employee that has a subscription, nor marked so for one switched off', () => {
    expect(chip(employee({ status: 'idle' })).container.querySelector('.sslot')!.className).not.toContain('no-plan');
    const off = chip(employee({ status: 'off', on: false })).container.querySelector('.sslot')!.className;
    expect(off).toContain('off');
    expect(off).not.toContain('no-plan');
  });
});
