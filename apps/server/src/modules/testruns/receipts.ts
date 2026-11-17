import { runsInClass, TestExecution, TestEnvironmentReceipt, type EnvironmentSnapshot, type RuntimeCapability } from '@hornhoof/protocol';
import type { TestEnvironmentSelection, testParts } from '../../db/schema.js';

function receiptIdentity(snapshot: EnvironmentSnapshot, receipt: TestEnvironmentReceipt): boolean {
  return receipt.commitSha === snapshot.description.commitSha && receipt.manifestHash === snapshot.description.manifestHash;
}
function receiptSelection(snapshot: EnvironmentSnapshot, selection: TestEnvironmentSelection, receipt: TestEnvironmentReceipt): boolean {
  if (receipt.version === 1) {
    const assigned = selection.selection;
    return TestExecution.safeParse({ snapshot, selection: assigned }).success && 'files' in assigned && receipt.kind === assigned.kind && receipt.suiteId === assigned.suiteId && JSON.stringify(receipt.files) === JSON.stringify(assigned.files);
  }
  const assigned = TestExecution.safeParse({ snapshot, selection: selection.selection }), reported = TestExecution.safeParse({ snapshot, selection: receipt.selection });
  return receipt.profile === snapshot.profile && assigned.success && reported.success && JSON.stringify(assigned.data.selection) === JSON.stringify(reported.data.selection);
}
function expectedOutcomes(snapshot: EnvironmentSnapshot, receipt: Extract<TestEnvironmentReceipt, { version: 2 }>): number {
  const preparation = snapshot.description.manifest.execution?.oncePreparation;
  return receipt.selection.kind === 'batch' ? receipt.selection.selections.length : (preparation?.suiteIds.length ?? 0) + (preparation?.commands.length ?? 0);
}
function receiptOutcomes(snapshot: EnvironmentSnapshot, receipt: TestEnvironmentReceipt, message: Extract<import('@hornhoof/protocol').NodeMessage, { type: 'tests.done' }>): boolean {
  if (receipt.version === 1) return true;
  if (message.commit !== receipt.commitSha || receipt.outcomes.length !== expectedOutcomes(snapshot, receipt)) return false;
  return !message.ok || (message.exitCode === 0 && message.error === null && receipt.outcomes.every(outcome => outcome.status === 'passed'));
}
const samePlatform = (a: RuntimeCapability['platform'], b: RuntimeCapability['platform']): boolean => a?.os === b?.os && a?.arch === b?.arch && a?.libc === b?.libc;
const sameRuntime = (a: RuntimeCapability, b: RuntimeCapability): boolean => a.id === b.id && a.fingerprint === b.fingerprint && a.version === b.version && samePlatform(a.platform, b.platform);
/* A part proves its files on any runtimes of the class that described its run (runsInClass), and only on the very runtimes the
   node that ran it said it has. */
function receiptRuntimes(snapshot: EnvironmentSnapshot, receipt: TestEnvironmentReceipt, known: RuntimeCapability[]): boolean {
  return runsInClass(snapshot, receipt.runtimes) && receipt.runtimes.every(actual => known.some(runtime => sameRuntime(runtime, actual)));
}
/* Mutation is proved by its own suite, so a part's receipt names none. */
const receiptMutations = (receipt: TestEnvironmentReceipt): boolean => !receipt.mutations?.length;
export function productReceipt(snapshot: EnvironmentSnapshot | null, selection: TestEnvironmentSelection | null, message: Extract<import('@hornhoof/protocol').NodeMessage, { type: 'tests.done' }>, known: RuntimeCapability[]): TestEnvironmentReceipt | null {
  const parsed = TestEnvironmentReceipt.safeParse(message.environmentReceipt);
  if (!snapshot || !selection || !parsed.success) return null;
  const receipt = parsed.data;
  return receiptIdentity(snapshot, receipt) && receiptSelection(snapshot, selection, receipt) && receiptOutcomes(snapshot, receipt, message) && receiptRuntimes(snapshot, receipt, known) && receiptMutations(receipt) ? receipt : null;
}

/* A part keeps its receipt only when it was accepted against the runtimes its node said it has as the part ended, so the runtimes it
   names stand for that node here; everything else is checked again. */
export function passedProductPart(snapshot: EnvironmentSnapshot, part: typeof testParts.$inferSelect): boolean {
  if (part.status !== 'passed' || part.commit !== snapshot.description.commitSha || part.exitCode !== 0 || part.error !== null || !part.finishedAt) return false;
  return productReceipt(snapshot, part.environmentSelection, { type: 'tests.done', partId: part.id, ok: true, commit: part.commit, exitCode: 0, error: null, log: '',
    ...(part.environmentReceipt ? { environmentReceipt: part.environmentReceipt } : {}) }, part.environmentReceipt?.runtimes ?? []) !== null;
}
