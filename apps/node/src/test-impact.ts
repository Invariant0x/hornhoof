import type { Command, TestEnvironmentV1, TestUnit } from '@hornhoof/protocol';

export type ImpactAdapter = 'vitest-related' | 'pytest';
export interface ImpactPackage { id: string; root: string; language?: string; suiteIds: string[] }
export interface ImpactEnvironment {
  packages: ImpactPackage[];
  impact: TestEnvironmentV1['impact'];
  inventory: TestUnit[];
}
export interface ImpactChange { path: string; kind: 'added' | 'modified' | 'deleted' | 'renamed'; previousPath?: string }
export interface ImpactGraph { adapter: ImpactAdapter; status: 'ready' | 'unavailable'; units: TestUnit[] }
export interface ImpactInput { environment: ImpactEnvironment; changes: ImpactChange[]; graphs: ImpactGraph[] }
export interface ImpactReason { code: string; path: string }
export interface ImpactPackageSelection { packageId: string; mode: 'related' | 'whole-package'; units: TestUnit[]; reasons: ImpactReason[] }
export interface ImpactSelection {
  version: 1;
  status: 'ready' | 'blocked';
  units: TestUnit[];
  packages: ImpactPackageSelection[];
  migrationChecks: { direction: 'up' | 'down'; command: Command }[];
  problems: { code: 'impact_path_invalid' | 'impact_environment_invalid' | 'new_test_unmapped' | 'migration_check_unsupported' }[];
}

/* Explicit caller port only. Environment280 and authorcheck222 integration is intentionally separate. */
export function selectAffectedTests(input: ImpactInput): ImpactSelection {
  void input;
  return { version: 1, status: 'ready', units: [], packages: [], migrationChecks: [], problems: [] };
}
