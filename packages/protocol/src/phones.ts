import { z } from 'zod';

export const PHONE_LEASE_MS = 30_000;
export const PHONE_FRAME_MAX = 3 * 1024 * 1024;
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
/* The serial number of a phone plugged by cable into the node's machine, as adb lists it; adb connects nowhere for it. */
export const usbSerial = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value);
export const PhoneEndpoint = z.string().max(260).refine(value => networkEndpoint(value) || usbSerial(value));
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
export const PhonePairing = z.strictObject({ endpoint: z.string().max(260).refine(networkEndpoint), code: z.string().regex(/^[0-9]{6}$/) });
export const PhoneDevice = z.strictObject({ serial: PhoneSerial, status: z.enum(['device', 'offline', 'unauthorized', 'unverified']), model: z.string().max(100).nullable(), hardwareKey: PhoneHardwareKey.optional() });
export type PhoneDevice = z.infer<typeof PhoneDevice>;
export const PhoneElement = z.strictObject({
  ref: z.string().max(200), text: z.string().max(4096), description: z.string().max(4096), resource: z.string().max(256),
  package: z.string().max(256), class: z.string().max(256), password: z.boolean(), focused: z.boolean(), editable: z.boolean(),
  bounds: z.tuple([coordinate, coordinate, coordinate, coordinate]),
});
export type PhoneElement = z.infer<typeof PhoneElement>;
export const PhoneCapture = z.strictObject({
  jpeg: z.string().max(PHONE_FRAME_MAX).regex(/^[A-Za-z0-9+/]+={0,2}$/).nullable(), width: coordinate, height: coordinate,
  elements: z.array(PhoneElement).max(5000),
});
export type PhoneCapture = z.infer<typeof PhoneCapture>;
/* serial is how adb names the phone: its address on the network, host and port, by wireless debugging, or its serial number on a cable. */
export const PhoneBinding = z.strictObject({ phoneId: z.uuid(), serial: PhoneEndpoint, hardwareKey: PhoneHardwareKey });
export type PhoneBinding = z.infer<typeof PhoneBinding>;
export const PhoneGrant = z.strictObject({
  sessionId: z.uuid(), generation: z.number().int().nonnegative(), binding: PhoneBinding, expiresAt: z.iso.datetime(),
});
export type PhoneGrant = z.infer<typeof PhoneGrant>;

export const PhoneProbe = z.strictObject({ type: z.literal('phone.probe'), requestId: z.uuid(), endpoint: PhoneEndpoint, pairing: PhonePairing.optional() });
/* Which of these phones the node's adb lists now, and in what state. It only reads adb's list: it connects nowhere and asks
   no phone anything, and it names no phone the server did not ask about. */
export const PhoneList = z.strictObject({ type: z.literal('phone.list'), requestId: z.uuid(), serials: z.array(PhoneEndpoint).min(1).max(100) });
export const PhoneBaseline = z.strictObject({ type: z.literal('phone.baseline'), requestId: z.uuid(), binding: PhoneBinding });
/* Settings of a phone its computer lists. Whether the phone is there at all comes from phone.list alone, never from here. */
export const PhoneReadinessIssue = z.enum(['nodeUpdate', 'check', 'lock', 'awake', 'brightness', 'batterySaver', 'appSleep', 'deviceIdle', 'appBattery', 'debugTrust', 'prompt']);
export type PhoneReadinessIssue = z.infer<typeof PhoneReadinessIssue>;
const PhoneReadiness = z.array(PhoneReadinessIssue).max(PhoneReadinessIssue.options.length);
export const PhoneOpen = z.strictObject({ type: z.literal('phone.open'), requestId: z.uuid(), grant: PhoneGrant });
export const PhoneAction = z.strictObject({ type: z.literal('phone.action'), requestId: z.uuid(), sessionId: z.uuid(), generation: z.number().int().nonnegative(), operation: PhoneOperation });
export const PhoneRenew = z.strictObject({ type: z.literal('phone.renew'), sessionId: z.uuid(), generation: z.number().int().nonnegative(), expiresAt: z.iso.datetime() });
export const PhoneRevoke = z.strictObject({ type: z.literal('phone.revoke'), requestId: z.uuid(), sessionId: z.uuid(), generation: z.number().int().nonnegative(), binding: PhoneBinding });
/* Positions count code points of the text as the agent sent it. */
const TextPosition = z.number().int().min(0).max(4095);
const MissingTextSpan = z.strictObject({ start: TextPosition, count: z.number().int().min(1).max(4096) });
const TypingChecks = [
  z.strictObject({ kind: z.literal('typing_unverified') }),
  z.strictObject({ kind: z.literal('typing_dropped'), missing: z.array(MissingTextSpan).min(1).max(4096) }),
  z.strictObject({ kind: z.literal('typing_mismatch') }),
] as const;
/* What the field read back after typing shows; none means it holds the typed text. */
export const PhoneTypingCheck = z.discriminatedUnion('kind', TypingChecks);
export type PhoneTypingCheck = z.infer<typeof PhoneTypingCheck>;
/* next: where the untyped rest of the text starts. */
export const PhoneTypingIssue = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('typing_failed'), reason: z.enum(['phone_adb_failed', 'phone_keyboard_unavailable']), next: TextPosition, check: PhoneTypingCheck.optional() }),
  z.strictObject({ kind: z.literal('typing_partial'), next: TextPosition.min(1), check: PhoneTypingCheck.optional() }),
  ...TypingChecks,
]);
export type PhoneTypingIssue = z.infer<typeof PhoneTypingIssue>;
export const PhoneReply = z.strictObject({
  type: z.literal('phone.reply'), requestId: z.uuid(), status: z.enum(['ok', 'partial', 'failed', 'needs_person', 'session_gone', 'busy']),
  devices: z.array(PhoneDevice).max(100).optional(), capture: PhoneCapture.optional(), readiness: PhoneReadiness.optional(), typing: PhoneTypingIssue.optional(),
});
export type PhoneReply = z.infer<typeof PhoneReply>;
export const PhoneFrame = z.strictObject({
  type: z.literal('phone.frame'), sessionId: z.uuid(), generation: z.number().int().nonnegative(), sequence: z.number().int().nonnegative(),
  at: z.iso.datetime(), capture: PhoneCapture,
});
export type PhoneFrame = z.infer<typeof PhoneFrame>;
export const PhoneServerMessage = z.discriminatedUnion('type', [PhoneProbe, PhoneList, PhoneBaseline, PhoneOpen, PhoneAction, PhoneRenew, PhoneRevoke]);
export type PhoneServerMessage = z.infer<typeof PhoneServerMessage>;
