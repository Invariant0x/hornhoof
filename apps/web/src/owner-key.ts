import { api } from './api';
import { keyDefaults, type DeviceKey, type KeyDeps } from './owner-key-store';

export { KEY_ITERATIONS, browserKeyStore, canMakeKey, forgetOwnerKey, keyDefaults, type DeviceKey, type KeyDeps, type KeyStore } from './owner-key-store';

/* The key as the server holds it: the public half, and the private half wrapped with a key made from the password. */
export type StoredKey = { publicKey: string; wrapped: string; salt: string; iv: string; iterations: number };

const CURVE = { name: 'ECDSA', namedCurve: 'P-256' } as const;

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const text = String.fromCharCode(...new Uint8Array(bytes as ArrayBuffer));
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function serverKey(): Promise<StoredKey | null> {
  return (await api.get<{ key: StoredKey | null }>('/api/me/key')).key;
}

/* The key this device keeps, when it is the one the server holds for the person. One of another key, as after a reset
   of the password or another person's sign-in here, is dropped. */
export async function deviceKey(server: StoredKey | null, deps: Partial<KeyDeps> = {}): Promise<CryptoKey | null> {
  const { store } = { ...keyDefaults, ...deps };
  const kept = await store.get();
  if (kept && server && kept.publicKey === server.publicKey) return kept.privateKey;
  if (kept) await store.clear();
  return null;
}

/* Makes the person's key, once. The private half leaves this browser only wrapped: the wrapping key comes from the
   password, which the server checks and never keeps, so the server cannot open what it stores. On this device the
   private half stays as a key that signs and cannot be read out. */
export async function makeKey(password: string, deps: Partial<KeyDeps> = {}): Promise<DeviceKey> {
  const { store, subtle, iterations } = { ...keyDefaults, ...deps };
  const pair = await subtle.generateKey(CURVE, true, ['sign', 'verify']);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const typed = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const wrapping = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, typed, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  const wrapped = await subtle.wrapKey('pkcs8', pair.privateKey, wrapping, { name: 'AES-GCM', iv });
  const publicKey = base64url(await subtle.exportKey('spki', pair.publicKey));
  await api.put('/api/me/key', { password, publicKey, wrapped: base64url(wrapped), salt: base64url(salt), iv: base64url(iv), iterations });
  /* The half that could be exported is dropped here: what stays signs, and nothing more. */
  const privateKey = await subtle.unwrapKey('pkcs8', wrapped, wrapping, { name: 'AES-GCM', iv }, CURVE, false, ['sign']);
  const key = { publicKey, privateKey };
  await store.put(key);
  return key;
}

const fromBase64url = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));

/* On a device that does not keep the person's key yet: what the server holds is opened with the password, once, and the
   private half stays here as a key that signs and cannot be read out. Null for a password that does not open it. */
export async function unlockKey(server: StoredKey, password: string, deps: Partial<KeyDeps> = {}): Promise<CryptoKey | null> {
  const { store, subtle } = { ...keyDefaults, ...deps };
  const typed = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const wrapping = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64url(server.salt), iterations: server.iterations }, typed, { name: 'AES-GCM', length: 256 }, false, ['unwrapKey']);
  let privateKey: CryptoKey;
  try {
    privateKey = await subtle.unwrapKey('pkcs8', fromBase64url(server.wrapped), wrapping, { name: 'AES-GCM', iv: fromBase64url(server.iv) }, CURVE, false, ['sign']);
  } catch {
    return null;
  }
  await store.put({ publicKey: server.publicKey, privateKey });
  return privateKey;
}

/* A command that joins a machine carries the key of whoever runs it there, so the machine knows its owner from the
   command itself. Any other command stays as it is. */
export function withOwnerKey(command: string, publicKey: string): string {
  return command.includes(' --join ') && !command.includes('--owner-key') ? `${command} --owner-key ${publicKey}` : command;
}
