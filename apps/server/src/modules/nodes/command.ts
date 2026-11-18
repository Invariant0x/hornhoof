import { eq } from 'drizzle-orm';
import { viaOrchestrator, type Person } from '../../auth/session.js';
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

/* The command is sealed for the person's screen and returned to the person or the orchestrator that requested it.
   Any other mediated caller receives only the delivery status. */
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
  if (me.via && !viaOrchestrator(me)) return { shown: 'The command is shown to the person it was made for.' };
  return { id, command, expiresAt: row!.expiresAt.toISOString() };
}

/* Keep the owner lock until the new command is sealed, so another request sees it as visible when the lock opens. */
export async function createInstallCommand(db: Db, config: Config, me: Person, place: Parameters<typeof createNodeCode>[1]): ReturnType<typeof commandFor> {
  return db.transaction(async tx => commandFor(tx, config, me, await createNodeCode(tx, place)));
}
