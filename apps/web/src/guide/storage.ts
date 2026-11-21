import { GUIDE_STEPS, type GuideEvent, type GuideMode, type GuideRecord, type GuideStep, type GuideStorageKey, type PreSetupGuide } from './types';

const PRE_SETUP_KEY = 'hh-guide-pre-v1';
const HANDOFF_KEY = 'hh-guide-handoff-v1';
const RECORD_PREFIX = 'hh-guide-v1:';
const MODES = new Set<string>(['api_key', 'personal', 'later']);
const VALID_STEPS = new Set<string>(GUIDE_STEPS);

type HandoffPayload = { version: 1; mode: GuideMode; skipped: boolean };

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Storage may be unavailable or full; the guide keeps working for this visit. */
  }
}

function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* Ignore storage access errors. */
  }
}

export function guideStorageKey(id: GuideStorageKey): string {
  return `${RECORD_PREFIX}${id.origin}:${id.companyId}:${id.personId}`;
}

/* Pre-setup stores ONLY visibility in the browser of the current installation. */
export function loadPreSetupGuide(): PreSetupGuide {
  const raw = readJson(PRE_SETUP_KEY) as Partial<PreSetupGuide> | null;
  return { version: 1, skipped: raw?.skipped === true };
}

export function savePreSetupGuide(skipped: boolean): void {
  const payload: PreSetupGuide = { version: 1, skipped };
  writeJson(PRE_SETUP_KEY, payload);
}

export function clearPreSetupGuide(): void {
  removeKey(PRE_SETUP_KEY);
}

/* Written ONLY when Setup creates a new company via POST /api/setup (never by AcceptInvite or RestoreFromFile). */
export function recordSetupHandoff(mode: GuideMode): void {
  const pre = loadPreSetupGuide();
  const payload: HandoffPayload = { version: 1, mode, skipped: pre.skipped };
  writeJson(HANDOFF_KEY, payload);
}

function sanitizeSteps(raw: unknown): GuideStep[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((s): s is GuideStep => typeof s === 'string' && VALID_STEPS.has(s)))];
}

function sanitizeId(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function sanitizeMode(raw: unknown): GuideMode {
  return typeof raw === 'string' && MODES.has(raw) ? (raw as GuideMode) : 'later';
}

export function loadGuideRecord(key: GuideStorageKey): GuideRecord | null {
  const raw = readJson(guideStorageKey(key)) as Partial<GuideRecord> | null;
  if (!raw || raw.version !== 1 || raw.active !== true) return null;
  return {
    version: 1,
    active: true,
    skipped: raw.skipped === true,
    mode: sanitizeMode(raw.mode),
    done: sanitizeSteps(raw.done),
    departmentId: sanitizeId(raw.departmentId),
    goalId: sanitizeId(raw.goalId),
    taskId: sanitizeId(raw.taskId),
    workConfirmed: raw.workConfirmed === true,
  };
}

export function saveGuideRecord(key: GuideStorageKey, record: GuideRecord): void {
  const clean: GuideRecord = {
    version: 1,
    active: record.active,
    skipped: record.skipped,
    mode: sanitizeMode(record.mode),
    done: sanitizeSteps(record.done),
    departmentId: sanitizeId(record.departmentId),
    goalId: sanitizeId(record.goalId),
    taskId: sanitizeId(record.taskId),
    workConfirmed: record.workConfirmed,
  };
  writeJson(guideStorageKey(key), clean);
}

/* Transfers the temporary Setup handoff into the scoped (origin, company, person) record and deletes temporary keys. */
export function consumeSetupHandoff(key: GuideStorageKey, fallbackMode?: GuideMode): GuideRecord | null {
  const handoff = readJson(HANDOFF_KEY) as Partial<HandoffPayload> | null;
  if (!handoff && !fallbackMode) return null;
  const pre = loadPreSetupGuide();
  const mode = sanitizeMode(handoff?.mode ?? fallbackMode);
  const skipped = handoff?.skipped ?? pre.skipped;
  removeKey(HANDOFF_KEY);
  removeKey(PRE_SETUP_KEY);
  const record: GuideRecord = {
    version: 1,
    active: true,
    skipped,
    mode,
    done: ['company', 'account'],
    departmentId: null,
    goalId: null,
    taskId: null,
    workConfirmed: false,
  };
  saveGuideRecord(key, record);
  return record;
}

/* Lightweight in-tab event bus so real product form callbacks notify the guide without coupling screen props. */
type EventListener = (event: GuideEvent) => void;
const eventListeners = new Set<EventListener>();

export function emitGuideEvent(event: GuideEvent): void {
  eventListeners.forEach(fn => fn(event));
}

export function subscribeGuideEvents(listener: EventListener): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}
