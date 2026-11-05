import type { SubView } from '../types';

export function replaceSubscription(list: SubView[] | null, subscription: SubView, mode: 'update' | 'orchestrator'): SubView[] | null {
  return list?.map(sub => {
    if (sub.id === subscription.id) return { ...sub, ...subscription };
    return mode === 'orchestrator' ? { ...sub, isOrchestrator: false } : sub;
  }) ?? null;
}
