import { and, eq, isNotNull } from 'drizzle-orm';
import { OPERATOR_PICTURE_BYTES } from '@hornhoof/protocol/program-operator';
import type { Ctx } from '../../app.js';
import { decryptSecret } from '../../crypto/secrets.js';
import { agents, attachments, programOperatorCases, subscriptions } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { nodeIdentity } from '../nodes/hub.js';
import { requestProgramView } from './rpc.js';
import { PainterError } from './painter.js';
import { renderOperatorScreen } from './screen.js';
import { operatorTransaction } from './transactions.js';

type Case = typeof programOperatorCases.$inferSelect;

/* A picture of a case belongs to the case. It is never a company-wide task file or an attachment the operator supplies. The
   last picture stays when the program or its node has just gone away. */
export async function refreshCasePicture(ctx: Ctx, row: Case): Promise<void> {
  const view = await requestProgramView(ctx, { agentId: row.agentId, node: nodeIdentity(row.nodeId) });
  if (!view || view.result !== 'ok') return;
  const { rendered } = await renderPicture(view, await pictureSecrets(ctx, row.companyId));
  await operatorTransaction(ctx, async tx => {
    await tx.select(idOnly(agents)).from(agents).where(eq(agents.id, row.agentId)).for('update');
    await storeCasePicture(tx, row, rendered.png);
  });
}

type Tx = Parameters<Parameters<Ctx['db']['transaction']>[0]>[0];

export async function storeCasePicture(tx: Tx, row: Case, png: Buffer): Promise<void> {
  const [picture] = await tx.insert(attachments).values({ companyId: row.companyId, jobId: row.jobId, agentId: row.agentId, operatorCaseId: row.id, mediaType: 'image/png', bytes: png, size: png.length }).returning({ id: attachments.id });
  await tx.update(programOperatorCases).set({ pictureId: picture!.id }).where(eq(programOperatorCases.id, row.id));
}

/* Only the values of secrets are masked; nothing else on the screen is hidden. A drawing that failed or never finished says so,
   and names only what went wrong with it. */
export async function renderPicture(screen: { cols: number; rows: number; cells: string }, secrets: string[]) {
  const rendered = await renderOperatorScreen({ cells: screen.cells, cols: screen.cols, rows: screen.rows, secrets }).catch((err: unknown) => {
    throw err instanceof PainterError ? new ApiError(409, 'unavailable', `The program picture could not be drawn (${err.why}). Look again.`, 'programs_unavailable') : err;
  });
  if (rendered.png.length > OPERATOR_PICTURE_BYTES) throw new ApiError(413, 'validation', 'The program picture is too large.', 'attachment_invalid');
  return { rendered };
}

export async function pictureSecrets(ctx: Ctx, companyId: string): Promise<string[]> {
  const rows = await ctx.db.select({ secret: subscriptions.secretEnc }).from(subscriptions).where(and(eq(subscriptions.companyId, companyId), isNotNull(subscriptions.secretEnc)));
  return rows.flatMap(row => row.secret ? [decryptSecret(row.secret, ctx.config.secret)] : []);
}
