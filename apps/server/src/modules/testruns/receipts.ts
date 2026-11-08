import { mutationResultMatches, TestExecution, TestEnvironmentReceipt, supportsTestProfile, type EnvironmentSnapshot, type RuntimeCapability } from '@hornhoof/protocol';
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
function receiptRuntimes(snapshot: EnvironmentSnapshot, receipt: TestEnvironmentReceipt, known: RuntimeCapability[]): boolean {
  return supportsTestProfile(snapshot, receipt.runtimes) && receipt.runtimes.every(actual => known.some(runtime => runtime.id === actual.id && runtime.fingerprint === actual.fingerprint && runtime.version === actual.version));
}
function receiptMutations(snapshot: EnvironmentSnapshot, assigned: TestEnvironmentSelection, receipt: TestEnvironmentReceipt): boolean {
  const { mutation } = snapshot.description.manifest, scope = snapshot.candidate?.mutation;
  const selection = assigned.selection;
  const suites = selection.kind === 'batch' ? selection.selections : selection.kind === 'suite' ? [selection] : [];
  const required = mutation.status === 'supported' && snapshot.candidate ? suites.filter(suite => suite.files.some(file => mutation.sourcePaths.includes(file))) : [];
  const proofs = receipt.mutations ?? [];
  if (proofs.length !== required.length || new Set(proofs.map(proof => proof.suiteId)).size !== proofs.length) return false;
  return required.every(suite => {
    const proof = proofs.find(proof => proof.suiteId === suite.suiteId);
    const files = mutation.status === 'supported' ? suite.files.filter(file => mutation.sourcePaths.includes(file)) : [];
    return Boolean(scope && proof && mutationResultMatches(scope.selection, proof, files));
  });
}
export function productReceipt(snapshot: EnvironmentSnapshot | null, selection: TestEnvironmentSelection | null, message: Extract<import('@hornhoof/protocol').NodeMessage, { type: 'tests.done' }>, known: RuntimeCapability[]): TestEnvironmentReceipt | null {
  const parsed = TestEnvironmentReceipt.safeParse(message.environmentReceipt);
  if (!snapshot || !selection || !parsed.success) return null;
  const receipt = parsed.data;
  return receiptIdentity(snapshot, receipt) && receiptSelection(snapshot, selection, receipt) && receiptOutcomes(snapshot, receipt, message) && receiptRuntimes(snapshot, receipt, known) && receiptMutations(snapshot, selection, receipt) ? receipt : null;
}

export function passedProductPart(snapshot: EnvironmentSnapshot, part: typeof testParts.$inferSelect): boolean {
  if (part.status !== 'passed' || part.commit !== snapshot.description.commitSha || part.exitCode !== 0 || part.error !== null || !part.finishedAt) return false;
  return productReceipt(snapshot, part.environmentSelection, { type: 'tests.done', partId: part.id, ok: true, commit: part.commit, exitCode: 0, error: null, log: '',
    ...(part.environmentReceipt ? { environmentReceipt: part.environmentReceipt } : {}) }, snapshot.description.runtimeCapabilities) !== null;
}
