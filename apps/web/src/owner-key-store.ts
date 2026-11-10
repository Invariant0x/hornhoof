/* A person's own key on this device: the public half as the server holds it, and the private half as a key the browser
   signs with and never gives out. */
export type DeviceKey = { publicKey: string; privateKey: CryptoKey };
export type KeyStore = { get(): Promise<DeviceKey | null>; put(key: DeviceKey): Promise<void>; clear(): Promise<void> };

/* How many rounds are made of the password before the key is wrapped with what comes out. */
export const KEY_ITERATIONS = 600_000;

const DATABASE = 'hornhoof';
const STORE = 'owner-key';
const ENTRY = 'key';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const asked = indexedDB.open(DATABASE, 1);
    asked.onupgradeneeded = () => asked.result.createObjectStore(STORE);
    asked.onsuccess = () => resolve(asked.result);
    asked.onerror = () => reject(asked.error ?? new Error('IndexedDB did not open.'));
  });
}

async function inStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const asked = work(db.transaction(STORE, mode).objectStore(STORE));
      asked.onsuccess = () => resolve(asked.result);
      asked.onerror = () => reject(asked.error ?? new Error('IndexedDB refused the key.'));
    });
  } finally {
    db.close();
  }
}

let said = false;
/* A browser that keeps no such store, as a private window may, keeps no key on this device: it reads as empty, and the
   key is asked for again when it is next needed. Said once in the console. */
async function orNothing<T>(work: () => Promise<T>, nothing: T): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (!said) console.warn('This browser does not keep the key on this device.', err);
    said = true;
    return nothing;
  }
}

/* The browser's own store. It keeps the private half as a CryptoKey, which no script can read out. */
export const browserKeyStore: KeyStore = {
  get: () => orNothing(async () => ((await inStore('readonly', store => store.get(ENTRY) as IDBRequest<DeviceKey | undefined>)) ?? null), null),
  put: key => orNothing(async () => void (await inStore('readwrite', store => store.put(key, ENTRY))), undefined),
  clear: () => orNothing(async () => void (await inStore('readwrite', store => store.clear())), undefined),
};

/* What the key is made and kept with. The tests put a store in memory, Node's own crypto and few rounds here. */
export type KeyDeps = { store: KeyStore; subtle: SubtleCrypto; iterations: number };
export const keyDefaults: KeyDeps = { store: browserKeyStore, subtle: globalThis.crypto?.subtle, iterations: KEY_ITERATIONS };

/* The device lets go of the key: at sign-out, and when the server says the session is over. */
export function forgetOwnerKey(deps: Partial<KeyDeps> = {}): Promise<void> {
  return (deps.store ?? keyDefaults.store).clear();
}
