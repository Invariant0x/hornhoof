import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { PhoneRecordings } from '../src/ui/PhoneRecordings';
import { mockApi } from './api-mock';
import { until } from './until';

it('opens recorded frames, advances on virtual time and stops at the last frame', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  mockApi({ 'GET /api/tasks/t1/phone-recordings': [200, { recordings: [{ id: 's1', phone: 'Pixel', agent: 'Assistant', status: 'ended', reason: 'completed', startedAt: '2026-11-16T12:00:00Z', endedAt: '2026-11-16T12:01:00Z', frames: [1, 2].map(sequence => ({ sequence, at: `2026-11-16T12:00:0${sequence}Z`, masked: true, imageUrl: `/api/phone-sessions/s1/frames/${sequence}/image` })) }] }] });
  const view = render(<PhoneRecordings taskId="t1" />);
  try {
    expect(screen.getByRole('heading', { name: 'Phone recordings' })).toBeInTheDocument();
    await until(() => screen.queryByRole('button', { name: 'Open recording' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open recording' }));
    expect(screen.getByRole('img')).toHaveAttribute('src', '/api/phone-sessions/s1/frames/1/image');
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(screen.getByRole('img')).toHaveAttribute('src', '/api/phone-sessions/s1/frames/2/image');
    expect(screen.getByText('Frame 2 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next frame' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Close recording' }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  } finally { view.unmount(); vi.useRealTimers(); }
});
