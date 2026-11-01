import { eq } from 'drizzle-orm';
import type { Person } from '../../auth/session.js';
import type { Config } from '../../config.js';
import { encryptSecret } from '../../crypto/secrets.js';
import { hashToken } from '../../crypto/tokens.js';
import type { Db } from '../../db/client.js';
import { nodeCodes } from '../../db/schema.js';
import { publicUrl } from '../link/link.js';

/* The one command a person runs on their computer. The installer sets up Docker if needed, then the node. */
export const installCommand = (publicUrl: string, code: string): string => `curl -fsSL ${publicUrl}/install.sh | bash -s -- --join ${code}`;

/* What the orchestrator hears of a command he asked for. */
export const SHOWN_TO_CEO = 'The command is shown to the CEO in this window; it works once, for 24 hours.';

/* A command reaches only the person it was made for. Their own click gets it in the answer. One the orchestrator asked
   for is kept sealed for the CEO's screen, which shows it in his window, and he hears only that it is there: so the code
   never reaches an agent, its conversation or its terminal. */
export async function commandFor(db: Db, config: Config, me: Person, code: string): Promise<{ command: string } | { shown: string }> {
  const command = installCommand(await publicUrl(db, config), code);
  if (!me.via) return { command };
  await db.update(nodeCodes).set({ commandEnc: encryptSecret(command, config.secret) }).where(eq(nodeCodes.codeHash, hashToken(code)));
  return { shown: SHOWN_TO_CEO };
}
