import { z } from 'zod';

export const MODEL_CHECK_KINDS = [] as string[];
export const REASON_CODES = [] as string[];
export const INVALIDATION_CODES = [] as string[];
export const ReasonCode = z.unknown();
export const InvalidationCode = z.unknown();
export const CheckBinding = z.unknown();
export const CheckInput = z.unknown();
export const Case = z.unknown();
export const CheckResult = z.unknown();
export const CheckReceipt = z.unknown();
export const CheckUnavailable = z.unknown();
export const CertifiedCheck = z.unknown();
export const EvaluationCounts = z.unknown();
export const VerifiedEvaluation = z.unknown();
