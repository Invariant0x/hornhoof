import type { VerifiedEvaluation } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
import { freshModelCheck } from '../jobs/dispatch.js';
import type { Evaluation, RunModelCheck } from '../model-checks/run.js';
import { createEvaluationPort } from './evaluation-port.js';
import { createEvaluatorModelRunner, createModelCheckPorts } from './model-checks.js';
import type { ModelCheckPorts } from './ports.js';

/* What this server really checks with: a fresh call straight to a vendor's API, for a binding a passed run certified. */
export const liveCheckPorts = (ctx: Ctx): ModelCheckPorts => createModelCheckPorts(ctx, freshModelCheck(ctx));

/* What runs the examples of a check: the same fresh call, with no certificate asked of it, as it is what earns one. */
export const liveEvaluator = (ctx: Ctx): RunModelCheck => createEvaluatorModelRunner(freshModelCheck(ctx));

/* A passed run is the one thing that certifies a binding. The port weighs the result again under the check's own lock. */
export const certifyPassed = (ctx: Ctx) => async ({ bindingDigest, reportId, datasetHash, complete, infraErrors, mustBlockMisses, metrics, holdoutMetrics, evaluatedAt }: Evaluation): Promise<void> => {
  const verified: VerifiedEvaluation = { bindingDigest, reportId, datasetHash, complete, infraErrors, mustBlockMisses, metrics, holdoutMetrics, evaluatedAt };
  await createEvaluationPort(ctx).publishEvaluation(verified);
};
