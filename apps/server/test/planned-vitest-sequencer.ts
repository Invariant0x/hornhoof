import { BaseSequencer, type TestSpecification } from 'vitest/node';

/* Opt-in product test adapter. HH_TEST_FILES is the existing node-written selection,
   not an authority token or a replacement for the pinned environment description. */
export function selectPlannedVitestSpecs<T extends { moduleId: string }>(specs: T[], selected: unknown, cwd: string): T[] {
  void specs; void selected; void cwd;
  throw new Error('Planned Vitest sharding is not implemented.');
}

export default class PlannedVitestSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    void files;
    throw new Error('Planned Vitest sharding is not implemented.');
  }
}
