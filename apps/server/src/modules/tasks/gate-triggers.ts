import { matchesGlob } from 'node:path';
import type { CompareResult } from '../testruns/compare.js';
import { ApiError } from '../../errors.js';
import type { GateTriggers, Role, Templates } from '../templates/load.js';

export type GateChanges = {
  tasks: { riskClass?: string | null; body: string }[];
  paths: string[];
  diff: string;
  mode: 'turn' | 'pre-release' | 'improvement';
  incomplete?: boolean;
};

const risks: Record<string, string> = { money: 'money', access: 'access', security: 'security', data: 'data', деньги: 'money', доступ: 'access', безопасность: 'security', данные: 'data' };
const normalizedRisk = (text: string): string | undefined => risks[text.trim().toLowerCase().replace(/[.*]+$/, '')];

function taskRisks(task: GateChanges['tasks'][number]): string[] {
  const header = task.body.split('\n').slice(0, 20).flatMap(line => {
    const match = line.replaceAll('**', '').match(/^\s*(?:risk\s*class|riskClass|класс риска)\s*:\s*(\S+)/i);
    return match ? [normalizedRisk(match[1]!)] : [];
  });
  return [normalizedRisk(task.riskClass ?? ''), ...header].filter((r): r is string => r !== undefined);
}

const diffPatterns = {
  route: /\.\s*(?:get|post|put|patch|delete|head|options|all|route)\s*\(/,
  sql: /\bsql\s*`|\bexecute\s*\(/,
  subprocess: /\b(?:spawn|exec|execFile|fork)\s*\(/,
};

/* Removed lines, context and patch headers do not introduce a new boundary. */
const addedCode = (diff: string): string => diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n');

const conditions: Record<string, (triggers: GateTriggers, changes: GateChanges) => boolean> = {
  risk: (triggers, changes) => changes.tasks.some(task => taskRisks(task).some(r => triggers.riskClasses.includes(r as 'money' | 'access' | 'security' | 'data'))),
  path: (triggers, changes) => changes.paths.some(path => triggers.paths.some(glob => matchesGlob(path.replaceAll('\\', '/'), glob))),
  diff: (triggers, changes) => triggers.diffPatterns.some(pattern => diffPatterns[pattern].test(addedCode(changes.diff))),
  'pre-release': (triggers, changes) => changes.mode === 'pre-release' && triggers.beforeRelease,
  'compare-unavailable': (_triggers, changes) => changes.incomplete === true,
};

export function gateReasons(role: Role, changes: GateChanges): string[] {
  if (role.gate === null || role.schema === 'observer' || changes.mode === 'improvement') return [];
  const triggers = role.gateTriggers;
  if (!triggers) return ['always'];
  return Object.entries(conditions).filter(([, matches]) => matches(triggers, changes)).map(([reason]) => reason);
}

export function tasksUnder<T extends { id: string; parentId: string | null }>(all: T[], roots: string[]): T[] {
  const ids = new Set(roots);
  const byId = new Map(all.map(task => [task.id, task]));
  function included(task: T): boolean {
    const seen = new Set<string>();
    for (let at: T | undefined = task; at && !seen.has(at.id); at = byId.get(at.parentId ?? '')) {
      if (ids.has(at.id)) return true;
      seen.add(at.id);
    }
    return false;
  }
  return all.filter(included);
}

export function reviewChanges(tasks: GateChanges['tasks'], comparison: CompareResult): GateChanges {
  return {
    tasks,
    paths: comparison.complete ? comparison.paths : [],
    diff: comparison.complete ? comparison.diff : '',
    mode: tasks.some(task => /^Review mode:\s*pre-release\s*$/im.test(task.body)) ? 'pre-release' : 'turn',
    incomplete: !comparison.complete,
  };
}

function nonblockingRole(role: Role): boolean {
  return role.schema === 'observer' || (role.gate === null && Boolean(role.improvementLanes?.length));
}

export function requireBlockingGate(templates: Templates | undefined, roleKey: string | null): void {
  const role = templates?.roles.get(roleKey ?? '');
  if (role && nonblockingRole(role)) throw new ApiError(400, 'validation', 'An observer or improvement-only role is nonblocking and cannot be a gate.', 'task_invalid');
}
