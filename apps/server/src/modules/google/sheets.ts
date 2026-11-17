import { createPrivateKey, createSign } from 'node:crypto';
import { ApiError } from '../../errors.js';

export type StoredGoogleSecret =
  | { kind: 'service_account'; clientEmail: string; privateKey: string }
  | { kind: 'oauth'; account: string; clientId: string; clientSecret: string; refreshToken: string };

type GoogleKey = StoredGoogleSecret & { shareEmail: string | null };

type SheetCell = string | number | boolean | null;
type SheetSpec = { name?: string; headers?: string[]; rows: SheetCell[][] };
type CreatedSpreadsheet = { spreadsheetId: string; url: string } | { problem: string };
export type SpreadsheetCreator = (key: GoogleKey, input: { title: string; sheets: SheetSpec[] }) => Promise<CreatedSpreadsheet>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file';

const invalidGoogle = (message: string) => new ApiError(400, 'validation', message, 'google_sheets_invalid');

export function checkShareEmail(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.length > 254 || !EMAIL.test(trimmed)) {
    throw invalidGoogle('Enter a valid email address to share new spreadsheets with, or leave it empty.');
  }
  return trimmed;
}

function parseServiceAccount(obj: Record<string, unknown>): { secret: StoredGoogleSecret; account: string; keyLast4: string } {
  const clientEmail = typeof obj.client_email === 'string' ? obj.client_email.trim() : '';
  const privateKey = typeof obj.private_key === 'string' ? obj.private_key.trim() : '';
  if (!EMAIL.test(clientEmail) || !privateKey) {
    throw invalidGoogle('Service account JSON must contain client_email and private_key.');
  }
  try {
    createPrivateKey(privateKey);
  } catch {
    throw invalidGoogle('The private_key in the Google service account JSON could not be read.');
  }
  const keyId = typeof obj.private_key_id === 'string' ? obj.private_key_id.trim() : '';
  const fallback = privateKey.replace(/-----[^-]+-----/g, '').replace(/[^A-Za-z0-9]/g, '');
  const keyLast4 = (keyId.length >= 4 ? keyId.slice(-4) : fallback.slice(-4)) || '0000';
  return { secret: { kind: 'service_account', clientEmail, privateKey }, account: clientEmail, keyLast4 };
}

function parseOauth(obj: Record<string, unknown>): { secret: StoredGoogleSecret; account: string; keyLast4: string } {
  const clientId = typeof obj.client_id === 'string' ? obj.client_id.trim() : '';
  const clientSecret = typeof obj.client_secret === 'string' ? obj.client_secret.trim() : '';
  const refreshToken = typeof obj.refresh_token === 'string' ? obj.refresh_token.trim() : '';
  if (!clientId || !clientSecret || !refreshToken) {
    throw invalidGoogle('Paste a Google service account JSON or OAuth JSON with client_id, client_secret and refresh_token.');
  }
  const rawAccount = typeof obj.account === 'string' ? obj.account.trim() : '';
  const account = (rawAccount || clientId).slice(0, 120);
  const keyLast4 = refreshToken.slice(-4).padStart(4, '0');
  return { secret: { kind: 'oauth', account, clientId, clientSecret, refreshToken }, account, keyLast4 };
}

export function parseGoogleCredentials(raw: string): { secret: StoredGoogleSecret; account: string; keyLast4: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidGoogle('Paste valid JSON credentials for Google Sheets.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidGoogle('Google credentials must be a JSON object.');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.type === 'service_account' || ('client_email' in obj && 'private_key' in obj)) return parseServiceAccount(obj);
  return parseOauth(obj);
}

function signServiceAccountAssertion(clientEmail: string, privateKey: string, tokenUrl: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iss: clientEmail, scope: GOOGLE_SCOPES, aud: tokenUrl, iat: now, exp: now + 3600 }),
  ).toString('base64url');
  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  sign.end();
  return `${header}.${payload}.${sign.sign(privateKey).toString('base64url')}`;
}

async function fetchAccessToken(tokenUrl: string, key: GoogleKey, signal: AbortSignal): Promise<string> {
  const body =
    key.kind === 'service_account'
      ? new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: signServiceAccountAssertion(key.clientEmail, key.privateKey, tokenUrl),
        })
      : new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: key.clientId,
          client_secret: key.clientSecret,
          refresh_token: key.refreshToken,
        });
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'manual',
    signal,
  });
  const data = (await res.json().catch(() => null)) as { access_token?: string; error?: string } | null;
  if (!res.ok || !data?.access_token) {
    throw new Error(`Google token exchange answered ${res.status}${data?.error ? ` (${data.error})` : ''}.`);
  }
  return data.access_token;
}

function googleCell(value: SheetCell, bold = false) {
  const userEnteredValue =
    typeof value === 'number' && Number.isFinite(value)
      ? { numberValue: value }
      : typeof value === 'boolean'
        ? { boolValue: value }
        : { stringValue: value == null ? '' : String(value) };
  return bold ? { userEnteredValue, userEnteredFormat: { textFormat: { bold: true } } } : { userEnteredValue };
}

function buildSheetPayload(spec: SheetSpec, index: number) {
  const rowData = [
    ...(spec.headers?.length ? [{ values: spec.headers.map(h => googleCell(h, true)) }] : []),
    ...spec.rows.map(row => ({ values: row.map(c => googleCell(c, false)) })),
  ];
  const title = (spec.name?.trim() || `Sheet${index + 1}`).slice(0, 100);
  return { properties: { title }, data: [{ startRow: 0, startColumn: 0, rowData }] };
}

/* A call to Google with the access token of the company's key. */
type GoogleCall = { headers: Record<string, string>; signal: AbortSignal };

async function newSpreadsheet(sheetsUrl: string, call: GoogleCall, input: { title: string; sheets: SheetSpec[] }): Promise<{ id: string; url?: string } | { problem: string }> {
  const res = await fetch(`${sheetsUrl}/v4/spreadsheets`, {
    method: 'POST',
    headers: call.headers,
    body: JSON.stringify({
      properties: { title: input.title.trim().slice(0, 200) },
      sheets: input.sheets.map(buildSheetPayload),
    }),
    redirect: 'manual',
    signal: call.signal,
  });
  const created = (await res.json().catch(() => null)) as { spreadsheetId?: string; spreadsheetUrl?: string } | null;
  if (!res.ok || !created?.spreadsheetId) return { problem: `Google Sheets answered ${res.status} when creating the spreadsheet.` };
  return { id: created.spreadsheetId, url: created.spreadsheetUrl };
}

/* Opens the spreadsheet to the Google account the company named, for editing. What went wrong, or null. */
async function shareSpreadsheet(driveUrl: string, call: GoogleCall, id: string, email: string | null): Promise<string | null> {
  if (!email) return null;
  const res = await fetch(`${driveUrl}/drive/v3/files/${encodeURIComponent(id)}/permissions`, {
    method: 'POST',
    headers: call.headers,
    body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: email }),
    redirect: 'manual',
    signal: call.signal,
  });
  return res.ok ? null : `Google Drive answered ${res.status} when sharing the spreadsheet.`;
}

/* The address Google gave, when it is one of Google Sheets; else the one made from the spreadsheet's id. */
const sheetUrl = (id: string, given: string | undefined): string =>
  given?.startsWith('https://docs.google.com/') ? given : `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;

export function createOnGoogleSheets(tokenUrl: string, sheetsUrl: string, driveUrl: string, timeoutMs = 30_000): SpreadsheetCreator {
  return async (key, input) => {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const call = { headers: { authorization: `Bearer ${await fetchAccessToken(tokenUrl, key, signal)}`, 'content-type': 'application/json' }, signal };
      const created = await newSpreadsheet(sheetsUrl, call, input);
      if ('problem' in created) return created;
      const problem = await shareSpreadsheet(driveUrl, call, created.id, key.shareEmail);
      return problem ? { problem } : { spreadsheetId: created.id, url: sheetUrl(created.id, created.url) };
    } catch (err) {
      return { problem: err instanceof Error ? err.message : 'Google Sheets could not be reached.' };
    }
  };
}
