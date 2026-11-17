import type { PrivateValues } from '@hornhoof/protocol';
import { Readable } from 'node:stream';
import { ApiError } from '../../errors.js';

/* Never yield a secret to the receiver, including across transport chunks. Keep the possible prefix in memory until
   enough bytes arrive to decide. received() removes any earlier safe bytes if the stream is refused. */
export function privateUpload(body: unknown, values?: PrivateValues): unknown {
  if (!values || !(body instanceof Readable)) return body;
  const masks = values;
  const retained = values.retainedBytes;
  async function* checked(): AsyncGenerator<Buffer> {
    let pending = Buffer.alloc(0);
    for await (const chunk of body as AsyncIterable<Buffer>) {
      const bytes = Buffer.concat([pending, chunk]);
      const text = bytes.toString('utf8');
      if (masks.text(text) !== text) throw new ApiError(400, 'validation', 'This file contains a vault secret and was not saved. Remove the secret before attaching it.', 'attachment_invalid');
      const end = Math.max(0, bytes.length - retained);
      if (end) yield bytes.subarray(0, end);
      pending = bytes.subarray(end);
    }
    if (pending.length) yield pending;
  }
  return Readable.from(checked());
}
