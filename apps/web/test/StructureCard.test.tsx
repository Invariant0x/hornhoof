import { DEPARTMENT_TEMPLATES } from '@hornhoof/protocol';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { TEMPLATES } from '../src/templates';
import type { StructureItem } from '../src/types';
import { StructureCard } from '../src/ui/StructureCard';
import { mockApi } from './api-mock';

const ITEMS: StructureItem[] = [
  { template: 'operations', checked: true, note: 'Tools and accounts' },
  { template: 'development', checked: true, note: 'Builds both products', products: ['Mascot', 'Characters'] },
  { template: 'design', checked: true, note: 'Characters need a look' },
  { template: 'marketing', checked: true, note: 'Schools need to hear of it' },
  { template: 'sales', checked: true, note: 'Sells to schools' },
  { template: 'business_development', checked: false, note: 'Later' },
  { template: 'support', checked: false, note: 'No customers yet' },
  { template: 'finance', checked: false, note: 'The CEO does it for now' },
];

const PROPOSAL = { id: 'pr1', brief: 'Acme makes characters for schools.', items: ITEMS };
const noop = () => {};

describe('StructureCard', () => {
  it('counts the ticked departments and creates exactly those', async () => {
    const calls = mockApi({ 'POST /api/departments/build': [201, { created: ['a', 'b', 'c', 'd'], removed: [] }] });
    render(<StructureCard proposal={PROPOSAL} status="pending" departments={[]} onCorrect={noop} />);
    expect(screen.getByText('Company structure')).toBeInTheDocument();
    expect(screen.getByText('Mascot, Characters')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Design/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create departments (4)' }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({
      proposalId: 'pr1',
      items: [
        { template: 'operations', note: 'Tools and accounts' },
        { template: 'development', note: 'Builds both products', products: ['Mascot', 'Characters'] },
        { template: 'marketing', note: 'Schools need to hear of it' },
        { template: 'sales', note: 'Sells to schools' },
      ],
    });
  });

  it('starts at five and keeps Operations ticked', () => {
    render(<StructureCard proposal={PROPOSAL} status="pending" departments={[]} onCorrect={noop} />);
    expect(screen.getByRole('button', { name: 'Create departments (5)' })).toBeInTheDocument();
    const ops = screen.getByRole('checkbox', { name: /Operations/ });
    expect(ops).toBeChecked();
    expect(ops).toBeDisabled();
  });

  it('offers the missing templates with the default ticks when building by hand', async () => {
    const calls = mockApi({ 'POST /api/departments/build': [201, { created: [], removed: [] }] });
    render(<StructureCard manual={{ existing: ['operations', 'sales'] }} status="pending" departments={[]} onCorrect={noop} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(6);
    const ticked = screen.getAllByRole('checkbox').filter(b => (b as HTMLInputElement).checked).map(b => b.getAttribute('data-template'));
    expect(ticked).toEqual(['development', 'marketing', 'business_development']);
    fireEvent.click(screen.getByRole('button', { name: 'Create departments (3)' }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ items: [{ template: 'development', note: '' }, { template: 'marketing', note: '' }, { template: 'business_development', note: '' }] });
  });

  it('shows a change to an existing department by its name', () => {
    const departments = [{ id: 'd9', name: null, templateKey: 'finance' as const, roleCode: 'FIN', about: '', products: [], teams: [] }];
    render(<StructureCard proposal={{ id: 'pr2', brief: 'b', items: [{ department: 'd9', checked: true, note: 'Not yet', remove: true }] }} status="pending" departments={departments} onCorrect={noop} />);
    expect(screen.getByText('Finance')).toBeInTheDocument();
    expect(screen.getByText('Remove')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply changes (1)' })).toBeInTheDocument();
  });

  it('locks an applied card and a replaced one', () => {
    const { unmount } = render(<StructureCard proposal={PROPOSAL} status="applied" departments={[]} onCorrect={noop} />);
    expect(screen.getByText('Applied')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create departments (5)' })).toBeDisabled();
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
    unmount();
    render(<StructureCard proposal={PROPOSAL} status="replaced" departments={[]} onCorrect={noop} />);
    expect(screen.getByText('Replaced by a newer proposal')).toBeInTheDocument();
  });

  it('says why the click did not work', async () => {
    mockApi({ 'POST /api/departments/build': [409, { error: { code: 'conflict', message: 'Already applied.', reason: 'proposal_closed' } }] });
    render(<StructureCard proposal={PROPOSAL} status="pending" departments={[]} onCorrect={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create departments (5)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This card was already applied or replaced by a newer one.');
  });

  it('hands correcting in words to the window', () => {
    const onCorrect = vi.fn();
    render(<StructureCard proposal={PROPOSAL} status="pending" departments={[]} onCorrect={onCorrect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Correct in words' }));
    expect(onCorrect).toHaveBeenCalled();
  });

  it('speaks Russian', () => {
    localStorage.setItem('hh-lang', 'ru');
    try {
      render(
        <LanguageProvider>
          <StructureCard proposal={PROPOSAL} status="pending" departments={[]} onCorrect={noop} />
        </LanguageProvider>,
      );
      expect(screen.getByText('Структура компании')).toBeInTheDocument();
      expect(screen.getByText('Разработка')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Создать отделы (5)' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Поправить словами' })).toBeInTheDocument();
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });
});

describe('TEMPLATES', () => {
  it('match the templates the server knows', () => {
    expect(TEMPLATES).toEqual(DEPARTMENT_TEMPLATES);
  });
});
