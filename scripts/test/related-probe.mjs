import { relative, resolve } from 'node:path';
import { createVitest } from 'vitest/node';

/* Collection/graph evidence only. This helper never invokes test callbacks. */
export async function probe(options, changed) {
  const root = process.cwd();
  const vitest = await createVitest({ watch: false, maxWorkers: 2, ...options, ...(changed ? { related: [changed].flat().map(path => resolve(root, path)) } : {}) });
  try {
    const all = await vitest.globTestSpecifications();
    const selected = changed ? await vitest.getRelevantTestSpecifications() : all;
    const rows = specs => specs.map(spec => ({ project: spec.project.name, file: relative(root, spec.moduleId).replaceAll('\\', '/') }))
      .sort((a, b) => a.project.localeCompare(b.project) || a.file.localeCompare(b.file));
    return { projects: vitest.projects.map(p => p.name).sort(), all: rows(all), selected: rows(selected) };
  } finally { await vitest.close(); }
}

export const workspaces = [
  ['apps/server', 'vitest.config.ts'], ['apps/node', 'vitest.config.ts'],
  ['apps/web', 'vite.config.ts'], ['packages/protocol', 'vitest.config.ts'],
];

export function workspaceOptions(folder, config) {
  return { root: resolve(folder), config: resolve(folder, config) };
}

export function evidence(mode, changed, result) {
  console.log('HH_RELATED_WIDTH ' + JSON.stringify({ mode, changed, projects: result.projects, total: result.all.length,
    selected: result.selected.length, files: result.selected }));
}
