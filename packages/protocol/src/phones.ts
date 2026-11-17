import { z } from 'zod';

export const PHONE_LEASE_MS = 30_000;
/* A screen's picture in base64: a whole 1080x2400 screen of a photo is at most 10.4 MB as a PNG, 14 MB in base64. */
export const PHONE_FRAME_MAX = 16 * 1024 * 1024;
export const PhoneSerial = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/);
/* The address Wireless debugging shows, an IP address on the network and a port. Never a name or an address of the node's
   own machine, where its agents' tools listen (#1140). */
export const networkEndpoint = (value: string): boolean => {
  const match = /^(?:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})|\[([0-9a-fA-F:]+)\]):(\d{1,5})$/.exec(value);
  if (!match || Number(match[6]) < 1 || Number(match[6]) > 65535) return false;
  if (match[5] !== undefined) return /[1-9a-f]/i.test(match[5]) && !/^[0:]*1$/.test(match[5]) && !/^[0:]*ffff:/i.test(match[5]);
  const octets = match.slice(1, 5).map(Number);
  return octets.every(n => n <= 255) && octets[0] !== 0 && octets[0] !== 127;
};
export const PhoneEndpoint = z.string().max(260).refine(networkEndpoint);
const coordinate = z.number().int().min(0).max(32767);
export const PhoneOperation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('capture') }),
  z.strictObject({ kind: z.literal('tap'), x: coordinate, y: coordinate }),
  z.strictObject({ kind: z.literal('swipe'), x: coordinate, y: coordinate, toX: coordinate, toY: coordinate, ms: z.number().int().min(1).max(1000) }),
  z.strictObject({ kind: z.literal('text'), text: z.string().min(1).max(4096) }),
  z.strictObject({ kind: z.literal('key'), key: z.enum(['back', 'home']) }),
  z.strictObject({ kind: z.literal('app'), package: z.string().max(200).regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/) }),
  z.strictObject({ kind: z.literal('url'), url: z.string().max(2048).refine(value => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password && !/[\x00-\x20\x7f]/.test(value);
    } catch { return false; }
  }) }),
]);
export type PhoneOperation = z.infer<typeof PhoneOperation>;

export const PhoneHardwareKey = z.string().regex(/^[0-9a-f]{64}$/);
export const PhonePairing = z.strictObject({ endpoint: PhoneEndpoint, code: z.string().regex(/^[0-9]{6}$/) });
export const PhoneDevice = z.strictObject({ serial: PhoneSerial, status: z.enum(['device', 'offline', 'unauthorized', 'unverified']), model: z.string().max(100).nullable(), hardwareKey: PhoneHardwareKey.optional() });
export type PhoneDevice = z.infer<typeof PhoneDevice>;
export const PhoneElement = z.strictObject({
  ref: z.string().max(200), text: z.string().max(4096), description: z.string().max(4096), resource: z.string().max(256),
  package: z.string().max(256), class: z.string().max(256), password: z.boolean(), focused: z.boolean(), editable: z.boolean(),
  bounds: z.tuple([coordinate, coordinate, coordinate, coordinate]),
});
export type PhoneElement = z.infer<typeof PhoneElement>;
export const PhoneCapture = z.strictObject({
  png: z.string().max(PHONE_FRAME_MAX).regex(/^[A-Za-z0-9+/]+={0,2}$/).nullable(), width: coordinate, height: coordinate,
  elements: z.array(PhoneElement).max(5000),
});
export type PhoneCapture = z.infer<typeof PhoneCapture>;
/* serial is the phone's address on the network, host and port, as adb names a phone it reaches by wireless debugging. */
export const PhoneBinding = z.strictObject({ phoneId: z.uuid(), serial: PhoneEndpoint, hardwareKey: PhoneHardwareKey });
export type PhoneBinding = z.infer<typeof PhoneBinding>;
export const PhoneGrant = z.strictObject({
  sessionId: z.uuid(), generation: z.number().int().nonnegative(), binding: PhoneBinding, expiresAt: z.iso.datetime(),
});
export type PhoneGrant = z.infer<typeof PhoneGrant>;

export const PhoneProbe = z.strictObject({ type: z.literal('phone.probe'), requestId: z.uuid(), endpoint: PhoneEndpoint, pairing: PhonePairing.optional() });
export const PhoneOpen = z.strictObject({ type: z.literal('phone.open'), requestId: z.uuid(), grant: PhoneGrant });
export const PhoneAction = z.strictObject({ type: z.literal('phone.action'), requestId: z.uuid(), sessionId: z.uuid(), generation: z.number().int().nonnegative(), operation: PhoneOperation });
export const PhoneRenew = z.strictObject({ type: z.literal('phone.renew'), sessionId: z.uuid(), generation: z.number().int().nonnegative(), expiresAt: z.iso.datetime() });
export const PhoneRevoke = z.strictObject({ type: z.literal('phone.revoke'), requestId: z.uuid(), sessionId: z.uuid(), generation: z.number().int().nonnegative(), binding: PhoneBinding });
export const PhoneReply = z.strictObject({
  type: z.literal('phone.reply'), requestId: z.uuid(), status: z.enum(['ok', 'failed', 'needs_person', 'session_gone', 'busy']),
  devices: z.array(PhoneDevice).max(100).optional(), capture: PhoneCapture.optional(),
});
export type PhoneReply = z.infer<typeof PhoneReply>;
export const PhoneFrame = z.strictObject({
  type: z.literal('phone.frame'), sessionId: z.uuid(), generation: z.number().int().nonnegative(), sequence: z.number().int().nonnegative(),
  at: z.iso.datetime(), capture: PhoneCapture,
});
export type PhoneFrame = z.infer<typeof PhoneFrame>;
export const PhoneServerMessage = z.discriminatedUnion('type', [PhoneProbe, PhoneOpen, PhoneAction, PhoneRenew, PhoneRevoke]);
export type PhoneServerMessage = z.infer<typeof PhoneServerMessage>;
