import { z } from 'zod';

/* Prose is preserved in full; transport and attachment budgets bound its storage. */
export const Text = z.string();
