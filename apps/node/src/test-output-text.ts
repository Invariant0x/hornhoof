// Checks already bounded diagnostic bytes only, without authorizing or uploading them.
export function isValidTextOutput(_bytes: Uint8Array, _mediaType: string): boolean {
  return false;
}
