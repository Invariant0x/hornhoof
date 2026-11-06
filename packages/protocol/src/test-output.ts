import { z } from 'zod';
import { MAX_RUN_FILES, RUN_FILE_BYTES, RunFile } from './run-files.js';

/* Structural evidence only; registration, actual bytes and read authority belong to the existing runner/server. */
export const TestOutput = z.strictObject({ basename: RunFile, mediaType: z.enum(['image/png', 'application/json', 'text/plain']) });
export type TestOutput = z.infer<typeof TestOutput>;
const distinctNames = (outputs: readonly { basename: string }[]): boolean => {
  const keys = outputs.map(output => output.basename.normalize('NFKC').toLowerCase());
  return new Set(keys).size === keys.length;
};
export const TestOutputList = z.array(TestOutput).max(MAX_RUN_FILES).refine(distinctNames, 'Output names must not alias.');
export type TestOutputList = z.infer<typeof TestOutputList>;
const Saved = TestOutput.extend({
  status: z.literal('saved'), artifactId: z.uuid(), size: z.number().int().min(0).max(RUN_FILE_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const NotSaved = TestOutput.extend({ status: z.literal('not_saved'), problem: z.enum(['missing', 'invalid', 'upload_failed']) });
export const TestOutputReceipt = z.strictObject({
  runId: z.uuid(), partId: z.uuid(), commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  outputs: z.array(z.discriminatedUnion('status', [Saved, NotSaved])).max(MAX_RUN_FILES).refine(distinctNames, 'Output names must not alias.'),
});
export type TestOutputReceipt = z.infer<typeof TestOutputReceipt>;
