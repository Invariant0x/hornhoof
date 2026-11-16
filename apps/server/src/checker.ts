import type { z } from 'zod';

/* What code that only checks a value needs of its schema, and what it gets back. Asking for all of z.ZodType<T> instead
   made the type check compare every method of each schema handed over, member by member, for each schema anew. */
export type Checker<T> = { parse(data: unknown): T; safeParse(data: unknown): z.ZodSafeParseResult<T> };
