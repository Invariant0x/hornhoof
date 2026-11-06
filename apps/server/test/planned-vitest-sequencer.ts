import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RepositoryPath, TEST_DESCRIPTION_BYTES } from '@hornhoof/protocol';
import { z } from 'zod';
import { BaseSequencer, type TestSpecification, type Vitest } from 'vitest/node';

function plannedPaths(input: unknown, cwd: string): Set<string> {
  const result = z.array(RepositoryPath).min(1).max(10_000).safeParse(input);
  if (!result.success) throw new Error('Invalid planned selection.');
  const paths = result.data.map(file => resolve(cwd, file)), distinct = new Set(paths);
  if (distinct.size !== paths.length) throw new Error('The planned selection contains duplicate files.');
  return distinct;
}

/* Opt-in product test adapter. HH_TEST_FILES is the existing node-written selection,
   not an authority token or a replacement for the pinned environment description. */
export function selectPlannedVitestSpecs<T extends { moduleId: string }>(specs: T[], selected: unknown, cwd: string): T[] {
  const paths = plannedPaths(selected, cwd), collected = new Set(specs.map(spec => resolve(cwd, spec.moduleId)));
  for (const file of paths) if (!collected.has(file)) throw new Error('A file in the planned selection was not collected.');
  return specs.filter(spec => paths.has(resolve(cwd, spec.moduleId)));
}

async function selectionInput(): Promise<unknown> {
  if (!process.env.HH_TEST_FILES) throw new Error('The planned selection requires HH_TEST_FILES.');
  const file = await open(process.env.HH_TEST_FILES, 'r');
  try {
    const bytes = Buffer.alloc(TEST_DESCRIPTION_BYTES + 1), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > TEST_DESCRIPTION_BYTES) throw new Error('The planned selection exceeds its byte limit.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))) as unknown;
  } finally { await file.close(); }
}

export default class PlannedVitestSequencer extends BaseSequencer {
  private selected: Promise<Set<string>> | undefined;
  constructor(ctx: Vitest) {
    super(ctx);
    if (!ctx.config.shard) throw new Error('The planned selection requires --shard.');
  }
  private async selectedFiles(): Promise<Set<string>> {
    // Collect across all sequence groups so a selected file in another group is not mistaken for missing.
    const specs = await this.ctx.getRelevantTestSpecifications(this.ctx.filenamePattern);
    return new Set(selectPlannedVitestSpecs(specs, await selectionInput(), process.cwd()).map(spec => resolve(spec.moduleId)));
  }
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const selected = await (this.selected ??= this.selectedFiles());
    return files.filter(file => selected.has(resolve(file.moduleId)));
  }
}
