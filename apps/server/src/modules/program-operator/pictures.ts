import { and, eq, isNotNull } from 'drizzle-orm';
import { OPERATOR_PICTURE_BYTES, OPERATOR_PROTECTED_SCREEN, type OperatorScreen } from '@hornhoof/protocol/program-operator';
import type { Ctx } from '../../app.js';
import { decryptSecret } from '../../crypto/secrets.js';
import { agents, attachments, programOperatorCases, subscriptions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { authorizeOperator, type OperatorCaller } from './authorization.js';
import { requestOperatorScreen } from './rpc.js';
import { renderOperatorScreen } from './screen.js';
import { operatorTransaction } from './transactions.js';

export type ScreenInput = { employee: string; case: string };

/* A picture belongs to the case. It is never a company-wide task file or an attachment supplied by the operator. */
export async function readProgramScreen(ctx: Ctx, caller: OperatorCaller, input: ScreenInput, report = false) {
  const authorized = await authorizeOperator(ctx, caller, input.case, input.employee, report);
  const screen = await requestOperatorScreen(ctx, authorized.row);
  if (!screen || screen.result !== 'ok' || !screen.snapshot) throw new ApiError(409, 'unavailable', `The existing program screen is unavailable: ${screen?.reason ?? 'node_unavailable'}.`, 'programs_unavailable');
  const secrets = await pictureSecrets(ctx, caller.companyId);
  const { protectedScreen, rendered } = renderPicture(screen, secrets);
  const pictureId = await operatorTransaction(ctx, async (tx, inside) => {
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, authorized.row.agentId)).for('update');
    const checked = await authorizeOperator(inside, caller, input.case, input.employee, report, true);
    const [picture] = await tx.insert(attachments).values({ companyId: caller.companyId, jobId: checked.row.jobId, agentId: checked.row.agentId, operatorCaseId: checked.row.id, mediaType: 'image/png', bytes: rendered.png, size: rendered.png.length }).returning({ id: attachments.id });
    await tx.update(programOperatorCases).set({ pictureId: picture!.id, snapshot: { token: screen.snapshot!, generation: screen.generation, at: new Date().toISOString(), keysAllowed: screen.keysAllowed && !protectedScreen, state: screen.state, cols: screen.cols, rows: screen.rows } }).where(eq(programOperatorCases.id, checked.row.id));
    return picture!.id;
  });
  return { case: input.case, employee: input.employee, snapshot: screen.snapshot, generation: screen.generation, state: screen.state, keysAllowed: screen.keysAllowed && !protectedScreen, reason: protectedScreen ? 'protected_screen' : screen.reason, pictureId, png: rendered.png, text: rendered.text };
}

export function renderPicture(screen: Pick<OperatorScreen, 'protected' | 'cols' | 'rows' | 'cells'> & Partial<Pick<OperatorScreen, 'reason'>>, secrets: string[]) {
  const protectedScreen = screen.protected || screen.reason === 'protected_screen';
  const rendered = renderOperatorScreen({ cells: protectedScreen ? OPERATOR_PROTECTED_SCREEN : screen.cells, cols: screen.cols, rows: screen.rows, secrets });
  if (rendered.png.length > OPERATOR_PICTURE_BYTES) throw new ApiError(413, 'validation', 'The program picture is too large.', 'attachment_invalid');
  return { protectedScreen, rendered };
}

export async function pictureSecrets(ctx: Ctx, companyId: string): Promise<string[]> {
  const rows = await ctx.db.select({ secret: subscriptions.secretEnc }).from(subscriptions).where(and(eq(subscriptions.companyId, companyId), isNotNull(subscriptions.secretEnc)));
  return rows.flatMap(row => row.secret ? [decryptSecret(row.secret, ctx.config.secret)] : []);
}
