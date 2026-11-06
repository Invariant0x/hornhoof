import type { TestUnit } from '@hornhoof/protocol';
import type { ImpactGraph } from './test-impact.js';

export interface ImpactRow { project: string; file: string }
export interface ImpactCollection { projects: string[]; all: ImpactRow[]; selected: ImpactRow[] }
export interface VitestImpactInput { inventory: TestUnit[]; projectSuites: Record<string, string[]>; changed: string[] }
export type RelatedCollector = (changed: string) => Promise<ImpactCollection>;
export interface PytestImpactResult { status: string; selected: string[]; reason: string | null }

export async function collectVitestImpact(input: VitestImpactInput, collect: RelatedCollector): Promise<ImpactGraph> {
  void input; void collect;
  return { adapter: 'vitest-related', status: 'unavailable', units: [] };
}

export function mapPytestImpact(result: PytestImpactResult, inventory: TestUnit[], suiteId: string, packageRoot: string): ImpactGraph {
  void result; void inventory; void suiteId; void packageRoot;
  return { adapter: 'pytest', status: 'unavailable', units: [] };
}
