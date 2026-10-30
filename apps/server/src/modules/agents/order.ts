import type { TemplateKey } from '@hornhoof/protocol';
import type { Templates } from '../templates/load.js';

type Ranked = { kind: string; roleKey: string | null; name: string; createdAt: Date };

/* How a department lists its employees: the head first, then in the order they were hired; people hired together in the order of the department's roster. */
export function employeeOrder(templates: Templates, templateKey: TemplateKey | null): (a: Ranked, b: Ranked) => number {
  const roster = templateKey ? templates.roster(templateKey).map(r => r.id) : [];
  const rank = (roleKey: string | null) => (roleKey && roster.includes(roleKey) ? roster.indexOf(roleKey) : roster.length);
  return (a, b) =>
    Number(b.kind === 'head') - Number(a.kind === 'head') || a.createdAt.getTime() - b.createdAt.getTime() || rank(a.roleKey) - rank(b.roleKey) || a.name.localeCompare(b.name);
}
