import { afterEach, describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import type { PhoneFrame, PhoneReply, PhoneGrant, SecretFilled } from '@hornhoof/protocol';
import { PhoneAdb } from '../src/phones/adb.js';
import { PhoneExecutor, type PhoneDriver } from '../src/phones/executor.js';
import { SecretFills } from '../src/secret-fill/index.js';
import { forgetExact, holdExact, redact } from '../src/redact.js';

const SESSION = '22222222-2222-4222-8222-222222222222';
const REQUEST = '11111111-1111-4111-8111-111111111111';
const PASSWORD = 'PASSWORD_UNIQUE_1079_MARKER';
const tree = (password = true, address = 'accounts.example/login') => `<hierarchy rotation="0"><node text="${address}" content-desc="" resource-id="com.android.chrome:id/url_bar" class="android.widget.TextView" package="com.android.chrome" password="false" focused="false" bounds="[0,0][3,1]"/><node text="${PASSWORD}" content-desc="${PASSWORD}" resource-id="password" class="android.widget.EditText" package="com.android.chrome" password="${String(password)}" focused="true" bounds="[0,1][3,3]"/></hierarchy>`;

function setup(options: { password?: boolean; address?: string } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const grant: PhoneGrant = { sessionId: SESSION, generation: 1, binding: { phoneId: '33333333-3333-4333-8333-333333333333', serial: '192.168.1.80:5555', endpoint: '192.168.1.80:5555', transport: 'network', hardwareKey: 'a'.repeat(64) }, expiresAt: '2026-11-16T12:00:30Z' };
  const outputs: (PhoneFrame | PhoneReply)[] = [];
  const fillsOut: SecretFilled[] = [];
  const typed: string[] = [];
  const logs: string[] = [];
  const png = new PNG({ width: 3, height: 3 });
  png.data.fill(255);
  const driver: PhoneDriver = {
    connect: async () => 'connected', pair: async () => 'paired', identity: async () => 'a'.repeat(64), devices: async () => [{ serial: grant.binding.serial, status: 'device', model: 'Pixel_8' }],
    tree: async () => tree(options.password, options.address), screenshot: async () => PNG.sync.write(png),
    act: async () => {}, type: async (_serial, value) => { typed.push(value); },
  };
  const phones = new PhoneExecutor({ drivers: { network: driver, usb: null }, send: m => outputs.push(m), hide: text => redact(text, []) });
  const fills = new SecretFills({
    open: async () => Buffer.from(JSON.stringify({ login: 'member@example.com', password: PASSWORD, totp: null })), hide: holdExact,
    send: m => fillsOut.push(m), log: line => logs.push(line),
  });
  fills.register(phones.fillAdapter());
  const fill = () => fills.handle({ type: 'secret.fill', requestId: REQUEST, jobId: null, entryId: '44444444-4444-4444-8444-444444444444', sealed: 'recorded-sealed-value', fields: ['password'], target: { kind: 'phone', phoneSessionId: SESSION, generation: 1, element: null, site: 'https://accounts.example' }, expiresAt: '2026-11-16T12:00:20Z' });
  return { grant, phones, fills, outputs, fillsOut, typed, logs, fill, driver };
}

afterEach(() => { forgetExact(); vi.useRealTimers(); });

describe('phone messages on the execution node', () => {
  it('probes the registered network phone without opening a session or exposing adb output', async () => {
    const outputs: (PhoneFrame | PhoneReply)[] = [];
    const adb = new PhoneAdb(async call => Buffer.from(call.args[0] === 'connect' ? 'connected to 192.168.1.80:5555\n' : call.args[0] === 'devices' ? 'List of devices attached\n192.168.1.80:5555 device model:Pixel_8 transport_id:1\nOTHER device model:Other\n' : call.args.at(-1) === 'ro.serialno' ? 'R58MIDENTITY\n' : call.args.at(-1) === 'ro.product.manufacturer' ? 'Samsung\n' : '0\n'));
    const phones = new PhoneExecutor({ drivers: { network: adb, usb: null }, send: message => outputs.push(message), hide: value => value });
    await phones.handle({ type: 'phone.probe', requestId: '11111111-1111-4111-8111-111111111111', transport: 'network', endpoint: '192.168.1.80:5555' });
    expect(outputs).toEqual([{
      type: 'phone.reply', requestId: '11111111-1111-4111-8111-111111111111', status: 'ok',
      devices: [{ serial: '192.168.1.80:5555', status: 'device', model: 'Pixel_8', hardwareKey: '8d29ea04a9efd53e779b8f1e97c6f99ba0df485be36e7dddb6b5bebf90a5a5df' }],
    }]);
  });

  it('uses the one shared fill core and keeps a unique password out of replies, frames and logs', async () => {
    const c = setup();
    await c.phones.handle({ type: 'phone.open', requestId: '55555555-5555-4555-8555-555555555555', grant: c.grant });
    await c.fill();
    expect(c.typed).toEqual([PASSWORD]);
    expect(c.fillsOut).toEqual([{ type: 'secret.filled', requestId: REQUEST, status: 'filled', filled: ['password'] }]);
    await c.phones.handle({ type: 'phone.action', requestId: '66666666-6666-4666-8666-666666666666', sessionId: SESSION, generation: 1, operation: { kind: 'capture' } });
    await vi.advanceTimersByTimeAsync(1500);
    const frame = c.outputs.find((m): m is PhoneFrame => m.type === 'phone.frame');
    expect(frame?.capture.png).toBeTruthy();
    expect(frame?.capture.elements[1]!.text).toBe('[hidden]');
    expect(JSON.stringify([c.outputs, c.fillsOut, c.logs])).not.toContain(PASSWORD);
    for (const output of c.outputs) {
      if (output.type === 'phone.frame' || output.capture) {
        const image = PNG.sync.read(Buffer.from(output.capture!.png!, 'base64'));
        expect([...image.data.subarray(12, 16)]).toEqual([0, 0, 0, 255]);
      }
    }
    c.phones.close();
  });

  it('does not type a password into an ordinary field or into a different Chrome site', async () => {
    const c = setup({ password: false });
    await c.phones.handle({ type: 'phone.open', requestId: '55555555-5555-4555-8555-555555555555', grant: c.grant });
    await c.fill();
    expect(c.fillsOut[0]!.status).toBe('wrong_field');
    expect(c.typed).toEqual([]);
    c.phones.close();
    const other = setup({ address: 'attacker.example/login' });
    await other.phones.handle({ type: 'phone.open', requestId: '55555555-5555-4555-8555-555555555555', grant: other.grant });
    await other.fill();
    expect(other.fillsOut[0]!.status).toBe('needs_person');
    expect(other.typed).toEqual([]);
    other.phones.close();
  });
});
