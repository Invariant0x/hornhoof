import type { EchelonsSnapshot, EchelonStage } from '@hornhoof/protocol/echelons';
import type { Messages } from '../i18n';

/* A document goes through its stages under plain names: nobody develops or reviews a letter. */
export function stageName(t: Messages, route: Pick<EchelonsSnapshot, 'resultKind'>, stage: EchelonStage): string {
  const labels = t.tasks.echelons;
  const plain: Partial<Record<EchelonStage, string>> = route.resultKind === 'document' ? labels.documentStages : {};
  return plain[stage] ?? labels.stages[stage];
}

/* Nothing of a document is merged: once its stages passed, it waits for the head to accept it. */
export function phaseName(t: Messages, route: Pick<EchelonsSnapshot, 'resultKind' | 'phase'>): string {
  const labels = t.tasks.echelons;
  return route.resultKind === 'document' && route.phase === 'ready' ? labels.documentReady : labels.phases[route.phase];
}
