import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { Phones, type PhoneView } from '../src/ui/Phones';
import { ME, mockApi } from './api-mock';
import { until } from './until';

const MACHINE = { id: 'm1', hostname: 'Work computer', online: true };
const PHONE: PhoneView = { id: 'ph1', name: 'My Pixel', owner: { id: ME.person.id, name: ME.person.name }, machineId: 'm1', online: true, lending: true, state: 'available', connection: 'ready', queued: 0, stopping: false, endpoint: '192.168.1.80:5555' };

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

it.each([
  ['en', en, /USB/, /Wireless debugging/],
  ['ru', ru, /USB/, /беспроводную отладку/],
] as const)('says in %s what to do with a phone its computer does not see, and only on that phone', async (language, t, cable, wireless) => {
  localStorage.setItem('hh-lang', language);
  onTestFinished(() => { localStorage.removeItem('hh-lang'); });
  const gone: PhoneView = { ...PHONE, online: false, state: 'offline', connection: 'not_connected' };
  const away: PhoneView = { ...PHONE, id: 'ph2', name: 'Phone on a sleeping computer', online: false, state: 'offline', connection: 'computer_offline' };
  const here: PhoneView = { ...PHONE, id: 'ph3', name: 'Phone in place' };
  mockApi({ 'GET /api/phones': [200, { phones: [gone, away, here] }] });
  render(<LanguageProvider><Phones me={ME} machines={[MACHINE]} /></LanguageProvider>);
  const card = await until(() => screen.queryByRole('article', { name: gone.name }));
  expect(t.phones.notConnected.hint).toMatch(cable);
  expect(t.phones.notConnected.hint).toMatch(wireless);
  expect(within(card).getByText(t.phones.notConnected.state)).toBeInTheDocument();
  expect(within(card).getByText(t.phones.notConnected.hint)).toBeInTheDocument();
  expect(t.phones.notConnected.state).not.toBe(t.phones.states.offline);
  const elsewhere = screen.getByRole('article', { name: away.name });
  expect(within(elsewhere).getByText(t.phones.states.offline)).toBeInTheDocument();
  expect(within(elsewhere).queryByText(t.phones.notConnected.hint)).toBeNull();
  const ready = screen.getByRole('article', { name: here.name });
  expect(within(ready).getByText(t.phones.states.available)).toBeInTheDocument();
  expect(within(ready).queryByText(t.phones.notConnected.hint)).toBeNull();
});

it.each([['en', en], ['ru', ru]] as const)('in %s shows a phone its computer does not see as a state to act on, with Watch off and its reason, and Stop on', async (language, t) => {
  localStorage.setItem('hh-lang', language);
  onTestFinished(() => { localStorage.removeItem('hh-lang'); });
  const gone: PhoneView = { ...PHONE, online: false, state: 'offline', connection: 'not_connected', queued: 2 };
  const here: PhoneView = { ...PHONE, id: 'ph3', name: 'Phone in place' };
  const calls = mockApi({
    'GET /api/phones': [200, { phones: [gone, here] }],
    'POST /api/phones/ph1/stop': [200, { ...gone, lending: false, state: 'owner', queued: 0 }],
  });
  render(<LanguageProvider><Phones me={ME} machines={[MACHINE]} /></LanguageProvider>);
  const card = await until(() => screen.queryByRole('article', { name: gone.name }));
  expect(within(card).getByText(t.phones.notConnected.state)).toHaveClass('status', 'not_connected');
  expect(within(card).getByText(t.phones.owner(ME.person.name))).not.toHaveClass('status');
  const watch = within(card).getByRole('button', { name: t.phones.watch });
  expect(watch).toBeDisabled();
  expect(watch).toHaveAccessibleDescription(t.phones.noScreen.not_connected);
  expect(within(card).getByText(t.phones.noScreen.not_connected)).toBeVisible();
  const stop = within(card).getByRole('button', { name: t.phones.stop });
  expect(stop).toBeEnabled();
  fireEvent.click(stop);
  await until(() => calls.find(c => c.method === 'POST' && c.path === '/api/phones/ph1/stop'));
  const ready = screen.getByRole('article', { name: here.name });
  expect(within(ready).getByText(t.phones.states.available)).not.toHaveClass('not_connected');
  expect(within(ready).getByRole('button', { name: t.phones.watch })).toBeEnabled();
  expect(within(ready).getByRole('button', { name: t.phones.watch })).not.toHaveAccessibleDescription();
  expect(within(ready).queryByText(t.phones.noScreen.not_connected)).toBeNull();
});

/* The phone leaves its computer, or the computer itself goes offline: the screen closes either way. */
it.each([
  ['its computer stops seeing the phone', { connection: 'not_connected' }],
  ['its computer goes offline', { connection: 'computer_offline' }],
] as const)('closes the screen when %s, and leaves it closed when the phone comes back', async (_, away) => {
  let listed = PHONE;
  mockApi({
    'GET /api/phones': () => [200, { phones: [listed] }],
    'GET /api/phones/ph1/live': [200, { lending: true, frame: { sequence: 1, at: '2026-11-16T12:00:00Z', imageUrl: '/api/phones/ph1/live/image?s=s1&v=1' } }],
  });
  render(<Phones me={ME} machines={[MACHINE]} />);
  fireEvent.click(await until(() => screen.queryByRole('button', { name: en.phones.watch })));
  await until(() => screen.queryByRole('img'));
  listed = { ...PHONE, online: false, state: 'offline', ...away };
  await act(() => vi.advanceTimersByTimeAsync(5000));
  await until(() => screen.queryByText(en.phones.noScreen[away.connection]));
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.getByRole('button', { name: en.phones.watch })).toHaveAttribute('aria-expanded', 'false');
  listed = PHONE;
  await act(() => vi.advanceTimersByTimeAsync(5000));
  await until(() => screen.queryByText(en.phones.states.available));
  expect(screen.getByRole('button', { name: en.phones.watch })).toBeEnabled();
  expect(screen.getByRole('button', { name: en.phones.watch })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('img')).toBeNull();
});

/* The states the style book draws: available is good, a computer offline is off, and its screen waits for the computer. */
it.each([['en', en], ['ru', ru]] as const)('in %s shows available as a good status and a computer offline as an off one, with Watch off and its reason', async (language, t) => {
  localStorage.setItem('hh-lang', language);
  onTestFinished(() => { localStorage.removeItem('hh-lang'); });
  const here: PhoneView = { ...PHONE, id: 'ph3', name: 'Phone in place' };
  const away: PhoneView = { ...PHONE, id: 'ph2', name: 'Phone on a sleeping computer', online: false, state: 'offline', connection: 'computer_offline', queued: 1 };
  const calls = mockApi({
    'GET /api/phones': [200, { phones: [here, away] }],
    'POST /api/phones/ph2/stop': [200, { ...away, lending: false, state: 'owner', queued: 0 }],
  });
  render(<LanguageProvider><Phones me={ME} machines={[MACHINE]} /></LanguageProvider>);
  const ready = await until(() => screen.queryByRole('article', { name: here.name }));
  expect(within(ready).getByText(t.phones.states.available)).toHaveClass('status', 'active');
  expect(within(ready).getByText(t.phones.owner(ME.person.name))).not.toHaveClass('status');
  const off = screen.getByRole('article', { name: away.name });
  expect(within(off).getByText(t.phones.states.offline)).toHaveClass('status', 'offline');
  expect(within(off).getByText(t.phones.owner(ME.person.name))).not.toHaveClass('status');
  const watch = within(off).getByRole('button', { name: t.phones.watch });
  expect(watch).toBeDisabled();
  expect(watch).toHaveAccessibleDescription(t.phones.noScreen.computer_offline);
  expect(within(off).getByText(t.phones.noScreen.computer_offline)).toBeVisible();
  expect(within(off).queryByText(t.phones.notConnected.hint)).toBeNull();
  const stop = within(off).getByRole('button', { name: t.phones.stop });
  expect(stop).toBeEnabled();
  fireEvent.click(stop);
  await until(() => calls.find(c => c.method === 'POST' && c.path === '/api/phones/ph2/stop'));
});

/* Settings belong to a phone that is there: a missing phone or an offline computer shows its own state and no settings. */
it.each([['en', en], ['ru', ru]] as const)('in %s shows phone settings only for a phone its computer sees', async (language, t) => {
  localStorage.setItem('hh-lang', language);
  onTestFinished(() => { localStorage.removeItem('hh-lang'); });
  const here: PhoneView = { ...PHONE, id: 'ph3', name: 'Phone in place', readiness: ['lock'] };
  const gone: PhoneView = { ...PHONE, id: 'ph1', online: false, state: 'offline', connection: 'not_connected', readiness: ['brightness'] };
  const away: PhoneView = { ...PHONE, id: 'ph2', name: 'Phone on a sleeping computer', online: false, state: 'offline', connection: 'computer_offline', readiness: null };
  mockApi({ 'GET /api/phones': [200, { phones: [here, gone, away] }] });
  render(<LanguageProvider><Phones me={ME} machines={[MACHINE]} /></LanguageProvider>);
  const ready = await until(() => screen.queryByRole('article', { name: here.name }));
  expect(within(ready).getByText(t.phones.readiness.lock)).toBeInTheDocument();
  const missing = screen.getByRole('article', { name: gone.name });
  expect(within(missing).getByText(t.phones.notConnected.hint)).toBeInTheDocument();
  expect(within(missing).queryByText(t.phones.readiness.brightness)).toBeNull();
  const off = screen.getByRole('article', { name: away.name });
  expect(within(off).getByText(t.phones.states.offline)).toBeInTheDocument();
  expect(within(off).queryByText(t.phones.readiness.checking)).toBeNull();
});
