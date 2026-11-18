import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
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
    render(<StructureCard proposal={PROPOSAL} departments={[]} onCorrect={noop} />);
    expect(screen.getByText('Company structure')).toBeInTheDocument();
    expect(screen.getByText('Mascot, Characters')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Design/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create departments (4)' }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({
      proposalId: 'pr1',
      items: [
        { template: 'operations', note: 'Tools and accounts', staff: true },
        { template: 'development', note: 'Builds both products', products: ['Mascot', 'Characters'], staff: true },
        { template: 'marketing', note: 'Schools need to hear of it', staff: true },
        { template: 'sales', note: 'Sells to schools', staff: true },
      ],
    });
  });

  it('creates new departments with the people of their templates unless that is unticked', async () => {
    const calls = mockApi({ 'POST /api/departments/build': [201, { created: ['a'], removed: [], hired: [] }] });
    render(<StructureCard manual={{ existing: ['operations', 'sales', 'marketing', 'business_development'] }} departments={[]} onCorrect={noop} />);
    const withPeople = screen.getByRole('checkbox', { name: /Hire the people of each template/ }) as HTMLInputElement;
    expect(withPeople.checked).toBe(true);
    fireEvent.click(withPeople);
    fireEvent.click(screen.getByRole('button', { name: 'Create departments (1)' }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ items: [{ template: 'development', note: '', staff: false }] });
  });

  it('starts at five and keeps Operations ticked', () => {
    render(<StructureCard proposal={PROPOSAL} departments={[]} onCorrect={noop} />);
    expect(screen.getByRole('button', { name: 'Create departments (5)' })).toBeInTheDocument();
    const ops = screen.getByRole('checkbox', { name: /Operations/ });
    expect(ops).toBeChecked();
    expect(ops).toBeDisabled();
  });

  it('offers the missing templates with the default ticks when building by hand', async () => {
    const calls = mockApi({ 'POST /api/departments/build': [201, { created: [], removed: [] }] });
    render(<StructureCard manual={{ existing: ['operations', 'sales'] }} departments={[]} onCorrect={noop} />);
    expect(screen.getAllByRole('checkbox').filter(b => b.hasAttribute('data-template'))).toHaveLength(9);
    const ticked = screen.getAllByRole('checkbox').filter(b => b.hasAttribute('data-template') && (b as HTMLInputElement).checked).map(b => b.getAttribute('data-template'));
    expect(ticked).toEqual(['development', 'marketing', 'business_development']);
    fireEvent.click(screen.getByRole('button', { name: 'Create departments (3)' }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ items: [{ template: 'development', note: '', staff: true }, { template: 'marketing', note: '', staff: true }, { template: 'business_development', note: '', staff: true }] });
  });

  it('offers Video production unticked, saying that it works through an API key of a video model', () => {
    render(<StructureCard manual={{ existing: ['operations'] }} departments={[]} onCorrect={noop} />);
    const video = screen.getByRole('checkbox', { name: /Video production/ }) as HTMLInputElement;
    expect(video.getAttribute('data-template')).toBe('video_production');
    expect(video.checked).toBe(false);
    expect(screen.getByText(/one look for every character from shot to shot[\s\S]*subscriptions of video sites do not work for agents/)).toBeInTheDocument();
  });

  it('shows a change to an existing department by its name', () => {
    const departments = [{ id: 'd9', name: null, templateKey: 'finance' as const, roleCode: 'FIN', about: '', agents: { total: 0, working: 0 }, products: [], teams: [], people: [], employees: [], roles: [] }];
    render(<StructureCard proposal={{ id: 'pr2', brief: 'b', items: [{ department: 'd9', checked: true, note: 'Not yet', remove: true }] }} departments={departments} onCorrect={noop} />);
    expect(screen.getByText('Finance')).toBeInTheDocument();
    expect(screen.getByText('Remove')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply changes (1)' })).toBeInTheDocument();
  });

  it('locks itself once applied and tells the window', async () => {
    mockApi({ 'POST /api/departments/build': [201, { created: ['a'], removed: [] }] });
    const onDone = vi.fn();
    render(<StructureCard proposal={PROPOSAL} departments={[]} onCorrect={noop} onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create departments (5)' }));
    expect(await screen.findByText('Applied')).toBeInTheDocument();
    expect(onDone).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create departments (5)' })).toBeDisabled();
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Correct in words' })).not.toBeInTheDocument();
  });

  it('can be hidden only when the window offers it', () => {
    const onHide = vi.fn();
    const { unmount } = render(<StructureCard proposal={PROPOSAL} departments={[]} onCorrect={noop} />);
    expect(screen.queryByRole('button', { name: 'Hide' })).not.toBeInTheDocument();
    unmount();
    render(<StructureCard manual={{ existing: [] }} departments={[]} onCorrect={noop} onHide={onHide} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(onHide).toHaveBeenCalled();
  });

  it('says why the click did not work', async () => {
    mockApi({ 'POST /api/departments/build': [409, { error: { code: 'conflict', message: 'Already applied.', reason: 'proposal_closed' } }] });
    render(<StructureCard proposal={PROPOSAL} departments={[]} onCorrect={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create departments (5)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This card was already applied or replaced by a newer one.');
  });

  it('hands correcting in words to the window', () => {
    const onCorrect = vi.fn();
    render(<StructureCard proposal={PROPOSAL} departments={[]} onCorrect={onCorrect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Correct in words' }));
    expect(onCorrect).toHaveBeenCalled();
  });

  it('speaks Russian', () => {
    localStorage.setItem('hh-lang', 'ru');
    try {
      render(
        <LanguageProvider>
          <StructureCard proposal={PROPOSAL} departments={[]} onCorrect={noop} />
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

  it('previews the sealed native structure proposal in MaterialViewer without calling build or mutating the original text when departments are unticked', async () => {
    const proposalDocId = '22222222-2222-4222-8222-222222222222';
    const contentUrl = `/api/proposals/pr1/materials/${proposalDocId}/content`;
    const sealedText = 'Original structure snapshot:\n- Operations\n- Development (Mascot, Characters)\n- Design';
    const calls: { method: string; path: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      if (method === 'GET' && path === '/api/proposals/pr1/materials') {
        return new Response(JSON.stringify({
          materialRevision: 1,
          materialDigest: 'c'.repeat(64),
          common: [{
            id: proposalDocId,
            name: 'Company structure proposal.txt',
            kind: 'document',
            format: 'text',
            state: 'available',
            contentUrl,
            downloadUrl: null,
            size: sealedText.length,
            sha256: 'd'.repeat(64),
            mediaType: 'text/plain',
          }],
          options: [],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (method === 'GET' && path === contentUrl) {
        return new Response(sealedText, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      return new Response(JSON.stringify({ created: ['a'], removed: [] }), { status: 201, headers: { 'content-type': 'application/json' } });
    }));

    const proposalWithMaterials = { ...PROPOSAL, materialRevision: 1 } as unknown as typeof PROPOSAL;
    render(<StructureCard proposal={proposalWithMaterials} departments={[]} onCorrect={noop} />);

    const openBtn = await screen.findByRole('button', { name: /Open material: Company structure proposal\.txt/ });
    fireEvent.click(screen.getByRole('checkbox', { name: /Design/ }));
    expect(screen.getByRole('button', { name: 'Create departments (4)' })).toBeInTheDocument();

    fireEvent.click(openBtn);
    const dialog = await screen.findByRole('dialog', { name: 'Company structure proposal.txt' });
    expect(await screen.findByText(/Original structure snapshot:/)).toBeInTheDocument();
    expect(screen.getByText('Original proposal. Your changes are not part of it.')).toBeInTheDocument();
    expect(dialog).toBeInTheDocument();
    expect(calls.filter(c => c.method === 'POST')).toEqual([]);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create departments (4)' })).toBeInTheDocument();
    expect(calls.filter(c => c.method === 'POST')).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Create departments (4)' }));
    await vi.waitFor(() =>
      expect(calls.find(c => c.method === 'POST')?.body).toMatchObject({
        proposalId: 'pr1',
        materialRevision: 1,
        materialDigest: 'c'.repeat(64),
      }),
    );
  });

  it('shows the localized alert without fake materials when GET /api/proposals/:id/materials returns 503 source_producer_unavailable', async () => {
    mockApi({
      'GET /api/proposals/pr1/materials': [503, { error: { code: 'unavailable', reason: 'source_producer_unavailable' } }],
    });
    const proposalWithMaterials = { ...PROPOSAL, materialRevision: 1 } as unknown as typeof PROPOSAL;
    const { container } = render(<StructureCard proposal={proposalWithMaterials} departments={[]} onCorrect={noop} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('The original proposal document is not available right now. Try again later.');
    expect(container.querySelectorAll('.mat')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Create departments (5)' })).toBeEnabled();
  });
});
