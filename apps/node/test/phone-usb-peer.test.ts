import { expect, it, vi } from 'vitest';
import { UsbPeer } from '../src/phones/usb-peer.js';
import { UsbHost, type UsbRequest } from '../src/phones/usb-host.js';
import { PhoneAdb } from '../src/phones/adb.js';

it('moves only validated bridge messages and replies between the node and host', async () => {
  const sent: UsbRequest[] = [];
  const host = new UsbHost({ adb: new PhoneAdb(async () => Buffer.from('List of devices attached\nUSB1079 device model:Pixel_8\n')), authorize: async () => true, send: message => peer.receive(message) });
  const peer = new UsbPeer(message => { sent.push(message as UsbRequest); void host.receive(message); }, () => host.close());
  const result = peer.driver(null).devices(new AbortController().signal);
  expect(sent).toHaveLength(1);
  await expect(result).resolves.toEqual([{ serial: 'USB1079', status: 'device', model: 'Pixel_8' }]);
  peer.close(); host.close();
});

it('fails closed on a missing host reply using virtual time and closes the peer', async () => {
  vi.useFakeTimers();
  const disconnected = vi.fn();
  const peer = new UsbPeer(() => {}, disconnected);
  try {
    const answer = peer.driver(null).devices(new AbortController().signal);
    const caught = expect(answer).rejects.toThrow('phone_usb_unavailable');
    await vi.advanceTimersByTimeAsync(20_000);
    await caught;
    expect(disconnected).toHaveBeenCalledOnce();
  } finally { peer.close(); vi.useRealTimers(); }
});
