import { z } from 'zod';

/* Test-first scaffold only. These schemas reject every input until the remote RED
   is observed. Nothing here provides a broker or native session capability. */
export const PublicBrowserKey = z.never();
export type PublicBrowserKey = z.infer<typeof PublicBrowserKey>;
export const BindViewRequest = z.never();
export type BindViewRequest = z.infer<typeof BindViewRequest>;
export const BindViewResponse = z.never();
export type BindViewResponse = z.infer<typeof BindViewResponse>;
export const ObserveRequest = z.never();
export type ObserveRequest = z.infer<typeof ObserveRequest>;
export const ViewProof = z.never();
export type ViewProof = z.infer<typeof ViewProof>;
export const ViewChallenge = z.never();
export type ViewChallenge = z.infer<typeof ViewChallenge>;
export const ViewSignature = z.never();
export type ViewSignature = z.infer<typeof ViewSignature>;
export const TestTerminalOrigin = z.never();
export type TestTerminalOrigin = z.infer<typeof TestTerminalOrigin>;
export const TestTerminalCursor = z.never();
export type TestTerminalCursor = z.infer<typeof TestTerminalCursor>;
export const TestTerminalServerFrame = z.never();
export type TestTerminalServerFrame = z.infer<typeof TestTerminalServerFrame>;
export const TestTerminalClose = z.never();
export type TestTerminalClose = z.infer<typeof TestTerminalClose>;
export const TestViewBindingContext = z.never();
export type TestViewBindingContext = z.infer<typeof TestViewBindingContext>;

export function encodeViewChallenge(_nonce: Uint8Array): string {
  throw new RangeError('View challenge encoding is not implemented.');
}
export function decodeViewChallenge(_challenge: string): Uint8Array {
  throw new RangeError('View challenge decoding is not implemented.');
}
export function encodeViewSignature(_signature: Uint8Array): string {
  throw new RangeError('View signature encoding is not implemented.');
}
export function decodeViewSignature(_signature: string): Uint8Array {
  throw new RangeError('View signature decoding is not implemented.');
}
export function checkTestViewBinding(_stored: unknown, _current: unknown, _nowMs: number): 'current' | 'stale' | 'expired' {
  return 'stale';
}
export function isTestViewReady(_response: unknown, _frame: unknown): boolean {
  return false;
}
