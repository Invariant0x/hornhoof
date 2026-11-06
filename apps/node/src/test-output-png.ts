export type PngOutputDimensions = { width: number; height: number };

// Content inspection only; declarations, file reads, ownership and upload stay with the runner.
export function pngOutputDimensions(_bytes: Uint8Array): PngOutputDimensions | null {
  void _bytes;
  return null;
}
