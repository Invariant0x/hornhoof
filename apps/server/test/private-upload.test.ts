import { Readable } from 'node:stream';
import { PrivateValues } from '@hornhoof/protocol';
import { expect, it } from 'vitest';
import { privateUpload } from '../src/modules/tools/private-upload.js';

it('refuses a streamed secret across chunk and UTF-8 boundaries before yielding it to storage', async () => {
  const marker = 'private-upload-маркер-1178';
  const values = new PrivateValues();
  values.remember(marker);
  const bytes = Buffer.from(`prefix ${marker} suffix`);
  const body = Readable.from([...bytes].map(byte => Buffer.from([byte])));
  const written: Buffer[] = [];
  const receive = async () => { for await (const chunk of privateUpload(body, values) as Readable) written.push(Buffer.from(chunk as Buffer)); };
  await expect(receive()).rejects.toMatchObject({ status: 400, reason: 'attachment_invalid' });
  expect(Buffer.concat(written).toString()).not.toContain(marker);
});

it('passes a safe binary stream byte for byte', async () => {
  const values = new PrivateValues();
  values.remember('private-upload-marker');
  const bytes = Buffer.from([0, 255, 11, 194, 128, 17]);
  const chunks: Buffer[] = [];
  for await (const chunk of privateUpload(Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]), values) as Readable) chunks.push(Buffer.from(chunk as Buffer));
  expect(Buffer.concat(chunks)).toEqual(bytes);
});
