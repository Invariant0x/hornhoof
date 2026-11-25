import { and, eq, isNotNull } from 'drizzle-orm';
import { OPERATOR_PICTURE_BYTES, type ProgramView } from '@hornhoof/protocol/program-operator';
import type { Ctx } from '../../app.js';
import { decryptSecret } from '../../crypto/secrets.js';
import { agents, attachments, programOperatorCases, subscriptions, vaultEntries } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { nodeIdentity } from '../nodes/hub.js';
import { settleAnsweredQuestions } from './cases.js';
import { requestProgramView } from './rpc.js';
import { PainterError } from './painter.js';
import { renderOperatorScreen } from './screen.js';
import { operatorTransaction } from './transactions.js';

type Case = typeof programOperatorCases.$inferSelect;

/* A picture of a case belongs to the case. It is never a company-wide task file or an attachment the operator supplies. The
   last picture stays when the program or its node has just gone away. What the fresh screen shows comes back, null when there
   is none; a question it no longer shows closes its case. */
export async function refreshCasePicture(ctx: Ctx, row: Case): Promise<ProgramView | null> {
  const view = await requestProgramView(ctx, { agentId: row.agentId, node: nodeIdentity(row.nodeId) });
  if (!view || view.result !== 'ok') return null;
  const { rendered } = await renderPicture(view, await pictureSecrets(ctx, row.companyId));
  await operatorTransaction(ctx, (tx, inside) => keepLook(tx, inside, row, view, rendered.png));
  return view;
}

/* A case its look closed already has that picture. */
async function keepLook(tx: Tx, inside: Ctx, row: Case, view: ProgramView, png: Buffer): Promise<void> {
  await tx.select(idOnly(agents)).from(agents).where(eq(agents.id, row.agentId)).for('update');
  const settled = await settleAnsweredQuestions(inside, row.agentId, view, png);
  if (!settled.includes(row.id)) await storeCasePicture(tx, inside.files, row, png);
}

type Tx = Parameters<Parameters<Ctx['db']['transaction']>[0]>[0];

export async function storeCasePicture(tx: Tx, files: Ctx['files'], row: Case, png: Buffer): Promise<void> {
  const kept = await files.putBytes(tx, png);
  const [picture] = await tx.insert(attachments).values({ companyId: row.companyId, jobId: row.jobId, agentId: row.agentId, operatorCaseId: row.id, mediaType: 'image/png', sha256: kept.sha256, size: kept.size }).returning({ id: attachments.id });
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

/* The plans' own secrets, and the passwords of the company's vault, which an agent types into a program to sign in as a person
   does and no node knows. */
export async function pictureSecrets(ctx: Ctx, companyId: string): Promise<string[]> {
  const rows = await ctx.db.select({ secret: subscriptions.secretEnc }).from(subscriptions).where(and(eq(subscriptions.companyId, companyId), isNotNull(subscriptions.secretEnc)));
  const vault = await ctx.db.select({ secret: vaultEntries.passwordEnc }).from(vaultEntries).where(eq(vaultEntries.companyId, companyId));
  return [...rows, ...vault].flatMap(row => row.secret ? [decryptSecret(row.secret, ctx.config.secret)] : []);
}
