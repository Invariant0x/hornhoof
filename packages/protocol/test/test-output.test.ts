import { describe, expect, it } from 'vitest';
import { TestOutput, TestOutputList, TestOutputReceipt } from '../src/index.js';

const OUTPUTS = [
  { basename: 'chromium.png', mediaType: 'image/png' },
  { basename: 'firefox.png', mediaType: 'image/png' },
  { basename: 'webkit.png', mediaType: 'image/png' },
  { basename: 'geometry.json', mediaType: 'application/json' },
  { basename: 'full.log', mediaType: 'text/plain' },
];
const saved = { ...OUTPUTS[0], status: 'saved', artifactId: '00000000-0000-4000-8000-000000000003', size: 8, sha256: 'a'.repeat(64) };
const receipt = { runId: '00000000-0000-4000-8000-000000000001', partId: '00000000-0000-4000-8000-000000000002', commitSha: 'b'.repeat(40), outputs: [saved, { ...OUTPUTS[1], status: 'not_saved', problem: 'missing' }] };

describe('declared test diagnostics', () => {
  it('preserves the bounded five-file browser consumer without an image, path or credential request', () => {
    expect(TestOutputList.parse(OUTPUTS)).toEqual(OUTPUTS);
  });

  it.each(['../out.png', '/tmp/out.png', 'sub/out.png', 'sub\\out.png', '.', '..', 'bad\nname', 'bad\0name'])('refuses a non-plain output name %j', basename => {
    expect(TestOutput.safeParse({ ...OUTPUTS[0], basename }).success).toBe(false);
  });

  it.each(['image/svg+xml', 'application/octet-stream', 'text/html'])('does not widen diagnostic media types to %s', mediaType => {
    expect(TestOutput.safeParse({ ...OUTPUTS[0], mediaType }).success).toBe(false);
  });

  it.each([
    ['same.png', 'same.png'], ['same.png', 'SAME.PNG'], ['caf\u00e9.png', 'cafe\u0301.png'],
  ])('refuses output aliases %j and %j', (first, second) => {
    expect(TestOutputList.safeParse([{ ...OUTPUTS[0], basename: first }, { ...OUTPUTS[0], basename: second }]).success).toBe(false);
  });

  it('retains the existing twenty-file limit', () => {
    const twenty = Array.from({ length: 20 }, (_, n) => ({ ...OUTPUTS[0], basename: `${n}.png` }));
    expect(TestOutputList.parse(twenty)).toEqual(twenty);
    expect(TestOutputList.safeParse([...twenty, { ...OUTPUTS[0], basename: 'twenty-first.png' }]).success).toBe(false);
  });

  it('records saved and missing diagnostics without declaring a test outcome', () => {
    expect(TestOutputReceipt.parse(receipt)).toEqual(receipt);
    expect(TestOutputReceipt.safeParse({ ...receipt, ok: true }).success).toBe(false);
  });

  it.each(['missing', 'invalid', 'upload_failed'])('retains explicit %s diagnostic failure without inventing an artifact', problem => {
    const value = { ...receipt, outputs: [{ ...OUTPUTS[0], status: 'not_saved', problem }] };
    expect(TestOutputReceipt.parse(value)).toEqual(value);
    expect(TestOutputReceipt.safeParse({ ...value, outputs: [{ ...value.outputs[0], artifactId: saved.artifactId }] }).success).toBe(false);
  });

  it.each([
    { runId: 'not-a-run' }, { partId: 'not-a-part' }, { commitSha: 'B'.repeat(40) }, { commitSha: 'b'.repeat(64) },
  ])('refuses invalid receipt identity %j', change => {
    expect(TestOutputReceipt.safeParse({ ...receipt, ...change }).success).toBe(false);
  });

  it.each([
    { artifactId: 'made-up' }, { size: -1 }, { size: 0.5 }, { size: 50 * 1024 * 1024 + 1 },
    { sha256: 'A'.repeat(64) }, { sha256: 'a'.repeat(63) }, { path: '/private/secret' },
  ])('refuses invalid saved artifact metadata %j', change => {
    expect(TestOutputReceipt.safeParse({ ...receipt, outputs: [{ ...saved, ...change }] }).success).toBe(false);
  });

  it('accepts the existing file-byte ceiling without raising it', () => {
    const value = { ...receipt, outputs: [{ ...saved, size: 50 * 1024 * 1024 }] };
    expect(TestOutputReceipt.parse(value)).toEqual(value);
  });

  it('refuses receipt aliases and undeclared saved fields', () => {
    expect(TestOutputReceipt.safeParse({ ...receipt, outputs: [saved, { ...saved, basename: 'CHROMIUM.PNG' }] }).success).toBe(false);
    expect(TestOutput.safeParse({ ...OUTPUTS[0], url: 'https://example.test/file' }).success).toBe(false);
  });
});
