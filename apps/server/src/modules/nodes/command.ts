import { eq } from 'drizzle-orm';
import type { Person } from '../../auth/session.js';
import type { Config } from '../../config.js';
import { encryptSecret } from '../../crypto/secrets.js';
import { hashToken } from '../../crypto/tokens.js';
import type { Db } from '../../db/client.js';
import { nodeCodes } from '../../db/schema.js';
import { publicUrl } from '../link/link.js';
import { createNodeCode } from './codes.js';

/* The command that updates every node on a computer that joined: the installer without a code moves them to the new
   image with their volumes, so each keeps its key and sign-in. It holds no code, so anyone may see it. */
export const updateCommand = (publicUrl: string): string => `curl -fsSL ${publicUrl}/install.sh | bash`;

/* The one command a person runs on their computer. The installer sets up Docker if needed, then the node. */
export const installCommand = (publicUrl: string, code: string): string => `${updateCommand(publicUrl)} -s -- --join ${code}`;

/* What the orchestrator hears of a command he asked for. */
export const SHOWN_TO_CEO = 'The command is shown to the CEO in this window; it works once, for 24 hours.';

/* A command reaches only the person it was made for. Their own click gets it in the answer and keeps it sealed for their
   screen until the machine joins, the day is over or they cancel it. One the orchestrator asked for is kept sealed for
   the CEO's screen, which shows it in his window, and he hears only that it is there: so the code never reaches an agent,
   its conversation or its terminal. */
export async function commandFor(
  db: Db,
  config: Config,
  me: Person,
  code: string,
): Promise<{ id: string; command: string; expiresAt: string } | { shown: string }> {
  const command = installCommand(await publicUrl(db, config), code);
  const id = hashToken(code);
  const [row] = await db
    .update(nodeCodes)
    .set({ commandEnc: encryptSecret(command, config.secret) })
    .where(eq(nodeCodes.codeHash, id))
    .returning({ expiresAt: nodeCodes.expiresAt });
  if (me.via) return { shown: SHOWN_TO_CEO };
  return { id, command, expiresAt: row!.expiresAt.toISOString() };
}

/* Keep the owner lock until the new command is sealed, so another request sees it as visible when the lock opens. */
export async function createInstallCommand(db: Db, config: Config, me: Person, place: Parameters<typeof createNodeCode>[1]): ReturnType<typeof commandFor> {
  return db.transaction(async tx => commandFor(tx, config, me, await createNodeCode(tx, place)));
}
