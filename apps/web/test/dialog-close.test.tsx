import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Settings } from '../src/screens/Settings';
import { Versions } from '../src/screens/Versions';
import type { Updates } from '../src/updates';
import { ME, mockApi } from './api-mock';

const updates: Updates = {
  view: { current: { version: '0.6.1', commit: 'a', migrations: 1 }, available: false, latest: null, versions: [], error: null, checkedAt: null, updater: { present: false, status: null, waiting: null } },
  busy: false, starting: false, target: null, offline: false, maintenance: false, asking: false, cut: null,
  check: async () => {}, update: async () => {}, callOff: async () => {}, confirmCut: async () => {}, dropCut: () => {},
};

function Dialog({ kind }: { kind: 'settings' | 'versions' }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  const close = () => setOpen(false);
  return kind === 'settings' ? <Settings me={ME} onClose={close} /> : <Versions updates={updates} onClose={close} />;
}

describe('account dialog Escape', () => {
  it.each(['settings', 'versions'] as const)('focuses %s and leaves a consumed Escape to the overlay above it', async kind => {
    mockApi({ 'GET /api/link': [200, { link: null, domain: 'example.test' }] });
    render(<Dialog kind={kind} />);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveFocus();
    const consumed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    consumed.preventDefault();
    fireEvent(document, consumed);
    expect(dialog).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(dialog).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(dialog).not.toBeInTheDocument();
  });
});
