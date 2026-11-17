import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { en } from '../src/i18n/en';
import { Phones, type PhoneView } from '../src/ui/Phones';
import { ME, mockApi } from './api-mock';
import { until } from './until';

const MACHINE = { id: 'm1', hostname: 'Work computer', online: true };
const PHONE: PhoneView = { id: 'ph1', name: 'My Pixel', owner: { id: ME.person.id, name: ME.person.name }, machineId: 'm1', online: true, lending: true, state: 'available', queued: 0, stopping: false, endpoint: '192.168.1.80:5555' };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  onTestFinished(() => { vi.useRealTimers(); });
});

it('shows only the owner controls and hides the live picture as soon as Stop returns', async () => {
  mockApi({
    'GET /api/phones': [200, { phones: [PHONE, { ...PHONE, id: 'ph2', name: 'Other phone', owner: { id: 'p2', name: 'Clara' } }] }],
    'GET /api/phones/ph1/live': [200, { lending: true, frame: { sequence: 1, at: '2026-11-16T12:00:00Z', imageUrl: '/api/phones/ph1/live/image?s=s1&v=1' } }],
    'POST /api/phones/ph1/stop': [200, { ...PHONE, lending: false, state: 'owner', stopping: true }],
  });
  render(<Phones me={ME} machines={[MACHINE]} />);
  await until(() => screen.queryByRole('button', { name: 'Watch screen' }));
  expect(screen.getAllByRole('button', { name: 'Stop' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Watch screen' }));
  await until(() => screen.queryByRole('img'));
  expect(screen.getByRole('img')).toHaveAttribute('src', '/api/phones/ph1/live/image?s=s1&v=1');
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await until(() => screen.queryByText('The screen is paused. The phone is in your hands.'));
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.getByText('Stop requested. Waiting for the computer to confirm.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Lend to assistants' })).toBeDisabled();
});

it('uses a pairing code only for the probe and removes it before saving', async () => {
  const calls = mockApi({
    'GET /api/phones': [200, { phones: [] }],
    'POST /api/phones/probe': [200, { devices: [{ serial: PHONE.endpoint, model: 'Pixel 8', status: 'device', hardwareKey: 'a'.repeat(64) }] }],
    'POST /api/phones': [201, PHONE],
  });
  render(<Phones me={ME} machines={[MACHINE]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add phone' }));
  fireEvent.change(screen.getByLabelText('Phone name'), { target: { value: PHONE.name } });
  fireEvent.change(screen.getByLabelText('Phone address'), { target: { value: PHONE.endpoint } });
  fireEvent.change(screen.getByLabelText(en.phones.pairingAddress), { target: { value: '192.168.1.80:43111' } });
  fireEvent.change(screen.getByLabelText(en.phones.pairingCode), { target: { value: '713924' } });
  fireEvent.click(screen.getByRole('button', { name: 'Find phone' }));
  await until(() => screen.queryByText(/Pixel 8/));
  expect(screen.getByLabelText(en.phones.pairingCode)).toHaveValue('');
  expect(calls.find(c => c.path === '/api/phones/probe')?.body).toMatchObject({ pairing: { endpoint: '192.168.1.80:43111', code: '713924' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add phone' }));
  await until(() => screen.queryByRole('article', { name: PHONE.name }));
  expect(JSON.stringify(calls.filter(c => c.path === '/api/phones'))).not.toContain('713924');
});

it('keeps Stop when an older list request finishes afterwards', async () => {
  let resolveList: (reply: [number, unknown]) => void = () => {};
  let reads = 0;
  mockApi({
    'GET /api/phones': () => ++reads === 1 ? [200, { phones: [PHONE] }] : new Promise(resolve => { resolveList = resolve; }),
    'POST /api/phones/ph1/stop': [200, { ...PHONE, lending: false, state: 'owner' }],
  });
  render(<Phones me={ME} machines={[MACHINE]} />);
  await until(() => screen.queryByRole('button', { name: 'Stop' }));
  await act(() => vi.advanceTimersByTimeAsync(5000));
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await until(() => screen.queryByText('In your hands'));
  await act(async () => resolveList([200, { phones: [PHONE] }]));
  expect(screen.getByText('In your hands')).toBeInTheDocument();
});

it('adds a network phone through labelled fields and returns control with Stop', async () => {
  const calls = mockApi({
    'GET /api/phones': [200, { phones: [] }],
    'POST /api/phones/probe': [200, { devices: [{ serial: PHONE.endpoint, model: 'Pixel 8', status: 'device', hardwareKey: 'a'.repeat(64) }] }],
    'POST /api/phones': [201, PHONE],
    'POST /api/phones/ph1/stop': [200, { ...PHONE, lending: false, state: 'owner' }],
  });
  render(<Phones me={ME} machines={[MACHINE]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add phone' }));
  expect(screen.getByLabelText('Phone name')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Find phone' }));
  expect(screen.getByLabelText('Phone name')).toHaveFocus();
  expect(screen.getByLabelText('Phone name')).toHaveAttribute('aria-invalid', 'true');
  fireEvent.change(screen.getByLabelText('Phone name'), { target: { value: PHONE.name } });
  fireEvent.change(screen.getByLabelText('Phone address'), { target: { value: PHONE.endpoint } });
  fireEvent.click(screen.getByRole('button', { name: 'Find phone' }));
  await until(() => screen.queryByText(/Pixel 8/));
  fireEvent.click(screen.getByRole('button', { name: 'Add phone' }));
  await until(() => screen.queryByRole('article', { name: PHONE.name }));
  expect(calls.find(c => c.method === 'POST' && c.path === '/api/phones')?.body).toEqual({ machineId: MACHINE.id, name: PHONE.name, endpoint: PHONE.endpoint });
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await until(() => screen.queryByText('In your hands'));
  expect(screen.getByRole('button', { name: 'Lend to assistants' })).toBeInTheDocument();
});
