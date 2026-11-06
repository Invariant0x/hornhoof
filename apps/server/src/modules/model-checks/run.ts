import { CheckReceipt, type Case, type CheckBinding, type CheckInput, type CheckResult, type CheckUnavailable } from '@hornhoof/protocol';
import type { Dataset } from './dataset.js';
import { bindingDigest, canonicalJson } from './lifecycle.js';
import { decide, scoreCases, type Counts, type Decision, type Scored, type Thresholds } from './score.js';

/* The port of a fresh, independent model call: #446 gives the call and #447 the evaluator. */
export type RunModelCheck = (binding: CheckBinding, input: CheckInput) => Promise<CheckReceipt | CheckUnavailable>;

/* What a run has until those land: no model. Nothing it says can pass a run, so no check can turn on without a real call. */
export const NO_MODEL_YET: RunModelCheck = async () => ({ kind: 'unavailable', code: 'unavailable' });

export type Evaluation = Omit<Scored, 'missedDevCases'> & { bindingDigest: string; reportId: string; datasetHash: string; evaluatedAt: string };
export type Report = { status: Decision['status']; problems: Decision['problems']; infraErrors: number; mustBlockMisses: number; all: Counts; holdout: Counts; missedDevCases: string[] };
export type RunOutcome = { evaluation: Evaluation; decision: Decision; report: Report };

/* The answer of a receipt that really is about this binding and this example, from the bound model. A failing call, a
   refusal and anything malformed all come to no answer, with nothing of what the provider said kept. */
function isAbout(receipt: CheckReceipt, binding: CheckBinding, digest: string, row: Case): boolean {
  return receipt.checkId === binding.checkId && receipt.bindingDigest === digest && receipt.subjectDigest === row.input.subject.contentDigest && canonicalJson(receipt.reviewer) === canonicalJson(binding.model);
}

async function answerOf(binding: CheckBinding, digest: string, row: Case, call: RunModelCheck): Promise<CheckResult | null> {
  try {
    const receipt = CheckReceipt.safeParse(await call(binding, row.input));
    return receipt.success && isAbout(receipt.data, binding, digest, row) ? receipt.data.result : null;
  } catch {
    return null;
  }
}

async function answersOf(binding: CheckBinding, digest: string, dataset: Dataset, call: RunModelCheck): Promise<Map<string, CheckResult>> {
  const answers = new Map<string, CheckResult>();
  for (const row of dataset.cases) {
    const answer = await answerOf(binding, digest, row, call);
    if (answer) answers.set(row.id, answer);
  }
  return answers;
}

/* One run over all of a set of examples. What it returns holds counts and ids only, no words of an example. */
export async function evaluateCheck(binding: CheckBinding, dataset: Dataset, thresholds: Thresholds | null, call: RunModelCheck, run: { reportId: string; now: Date }): Promise<RunOutcome> {
  const digest = bindingDigest(binding);
  const { missedDevCases, ...counted } = scoreCases(dataset.cases, await answersOf(binding, digest, dataset, call));
  const decision = decide({ ...counted, missedDevCases }, dataset, thresholds);
  return {
    decision,
    evaluation: { ...counted, bindingDigest: digest, reportId: run.reportId, datasetHash: dataset.hash, evaluatedAt: run.now.toISOString() },
    report: { status: decision.status, problems: decision.problems, infraErrors: counted.infraErrors, mustBlockMisses: counted.mustBlockMisses, all: counted.metrics, holdout: counted.holdoutMetrics, missedDevCases },
  };
}

const partLine = (name: string, part: Counts): string => `${name} ${part.total} examples: ${part.falseAllows} false yes, ${part.falseDenies} false no, ${part.classErrors} wrong classes, ${part.unavailable} without an answer.`;

export const reportText = (report: Report): string => [
  `The run ended as ${report.status}: ${report.problems.join(', ')}.`,
  `Must-block examples let through: ${report.mustBlockMisses}.`,
  partLine('All', report.all),
  partLine('Held-out', report.holdout),
].join('\n');
