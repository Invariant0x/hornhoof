import { afterEach, describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import type { PhoneFrame, PhoneReply, PhoneGrant, PhoneOperation } from '@hornhoof/protocol';
import { PhoneAdb } from '../src/phones/adb.js';
import { PhoneExecutor, type PhoneDriver } from '../src/phones/executor.js';
import { redact } from '../src/redact.js';

const SESSION = '22222222-2222-4222-8222-222222222222';
const PASSWORD = 'PASSWORD_UNIQUE_1079_MARKER';
const tree = () => `<hierarchy rotation="0"><node text="accounts.example/login" content-desc="" resource-id="com.android.chrome:id/url_bar" class="android.widget.TextView" package="com.android.chrome" password="false" focused="false" bounds="[0,0][3,1]"/><node text="${PASSWORD}" content-desc="${PASSWORD}" resource-id="password" class="android.widget.EditText" package="com.android.chrome" password="true" focused="true" bounds="[0,1][3,3]"/></hierarchy>`;

function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const grant: PhoneGrant = { sessionId: SESSION, generation: 1, binding: { phoneId: '33333333-3333-4333-8333-333333333333', serial: '192.168.1.80:5555', endpoint: '192.168.1.80:5555', transport: 'network', hardwareKey: 'a'.repeat(64) }, expiresAt: '2026-11-16T12:00:30Z' };
  const outputs: (PhoneFrame | PhoneReply)[] = [];
  const acted: PhoneOperation[] = [];
  const png = new PNG({ width: 3, height: 3 });
  png.data.fill(255);
  const driver: PhoneDriver = {
    connect: async () => 'connected', pair: async () => 'paired', identity: async () => 'a'.repeat(64), devices: async () => [{ serial: grant.binding.serial, status: 'device', model: 'Pixel_8' }],
    tree: async () => tree(), screenshot: async () => PNG.sync.write(png),
    act: async (_serial, operation) => { acted.push(operation as PhoneOperation); },
  };
  const phones = new PhoneExecutor({ drivers: { network: driver, usb: null }, send: m => outputs.push(m), hide: text => redact(text, []) });
  return { grant, phones, outputs, acted };
}

afterEach(() => { vi.useRealTimers(); });

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

  it('types the password the agent sends as ordinary text and keeps it out of replies and frames', async () => {
    const c = setup();
    await c.phones.handle({ type: 'phone.open', requestId: '55555555-5555-4555-8555-555555555555', grant: c.grant });
    await c.phones.handle({ type: 'phone.action', requestId: '66666666-6666-4666-8666-666666666666', sessionId: SESSION, generation: 1, operation: { kind: 'text', text: PASSWORD } });
    expect(c.acted).toEqual([{ kind: 'text', text: PASSWORD }]);
    await vi.advanceTimersByTimeAsync(1500);
    const frame = c.outputs.find((m): m is PhoneFrame => m.type === 'phone.frame');
    expect(frame?.capture.png).toBeTruthy();
    expect(frame?.capture.elements[1]!.text).toBe('[hidden]');
    expect(JSON.stringify(c.outputs)).not.toContain(PASSWORD);
    for (const output of c.outputs) {
      if (output.type === 'phone.frame' || output.capture) {
        const image = PNG.sync.read(Buffer.from(output.capture!.png!, 'base64'));
        expect([...image.data.subarray(12, 16)]).toEqual([0, 0, 0, 255]);
      }
    }
    c.phones.close();
  });

  it('runs no text action for a session the server revoked', async () => {
    const c = setup();
    await c.phones.handle({ type: 'phone.open', requestId: '55555555-5555-4555-8555-555555555555', grant: c.grant });
    await c.phones.handle({ type: 'phone.revoke', requestId: '77777777-7777-4777-8777-777777777777', sessionId: SESSION, generation: 1, binding: c.grant.binding });
    await c.phones.handle({ type: 'phone.action', requestId: '66666666-6666-4666-8666-666666666666', sessionId: SESSION, generation: 1, operation: { kind: 'text', text: PASSWORD } });
    expect(c.acted).toEqual([]);
    expect(c.outputs.at(-1)).toEqual({ type: 'phone.reply', requestId: '66666666-6666-4666-8666-666666666666', status: 'session_gone' });
    c.phones.close();
  });
});
