import { z } from 'zod';

/* Structural evidence only; registration, actual bytes and read authority belong to the existing runner/server. */
export const TestOutput = z.never();
export type TestOutput = z.infer<typeof TestOutput>;
export const TestOutputList = z.never();
export type TestOutputList = z.infer<typeof TestOutputList>;
export const TestOutputReceipt = z.never();
export type TestOutputReceipt = z.infer<typeof TestOutputReceipt>;
