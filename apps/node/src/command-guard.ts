/* RED stub for #539: it allows everything, so the tests show that they catch a guard that stops nothing. */
export type CommandInput = { command: string | readonly string[]; cwd: string; workspaceRoot: string };
export type CommandFiles = {
  lstat(path: string): Promise<'file' | 'directory' | 'symlink' | 'other' | null>;
  realpath(path: string): Promise<string | null>;
  read(path: string, maxBytes: number): Promise<string | null>;
};
export type CommandCoverage = 'recognized' | 'opaque';
export type CommandDenial = { allow: false; code: 'heavy_check_local' | 'dependency_install_local' | 'command_guard_unavailable'; category: string };
export type AgentCommandVerdict = { allow: true; kind: 'ordinary' | 'single_test_file' | 'lightweight_screenshot'; coverage: CommandCoverage } | CommandDenial;
export type WorkCommandVerdict = { allow: true; kind: 'ordinary' | 'dependency_preparation' | 'lightweight_screenshot'; coverage: CommandCoverage } | CommandDenial;

export const COMMAND_LIMITS = { commandBytes: 65_536, nesting: 32, stages: 256, resolving: 8, fileBytes: 1_048_576, fileReads: 32 };
export const localCommandFiles: CommandFiles = { lstat: () => Promise.resolve(null), realpath: () => Promise.resolve(null), read: () => Promise.resolve(null) };

export function classifyAgentCommand(_input: CommandInput, _files: CommandFiles = localCommandFiles): Promise<AgentCommandVerdict> {
  return Promise.resolve({ allow: true, kind: 'ordinary', coverage: 'recognized' });
}

export function classifyRunWork(_input: CommandInput, _files: CommandFiles = localCommandFiles): Promise<WorkCommandVerdict> {
  return Promise.resolve({ allow: true, kind: 'ordinary', coverage: 'recognized' });
}

export function refusalText(_denial: CommandDenial): string {
  return '';
}
