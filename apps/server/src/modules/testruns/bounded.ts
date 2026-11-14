/* An answer's body up to max bytes, read no further than that: null once it goes past. Leaving the loop early cancels the
   rest of the body, so a server that answers without end fills no memory. */
export async function bodyWithin(res: Response, max: number): Promise<Buffer | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > max) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
