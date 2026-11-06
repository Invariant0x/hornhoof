// Checks already bounded diagnostic bytes only, without authorizing or uploading them.
export function isValidTextOutput(bytes: Uint8Array, mediaType: string): boolean {
  if (mediaType !== 'text/plain' && mediaType !== 'application/json') return false;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (mediaType === 'application/json') JSON.parse(text);
    return true;
  } catch { return false; }
}
