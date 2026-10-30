import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEMPLATE_KEYS, type TemplateKey } from '@hornhoof/protocol';
import { parse } from 'yaml';
import { z } from 'zod';

/* Role and skill templates: the text every employee is hired with. Roles are short, procedures live in skills. */

export type Lang = { en: string; ru: string };
export type SkillKind = 'core' | 'procedure' | 'checklist' | 'gate';
export type Skill = { id: string; title: Lang; description: Lang; kind: SkillKind; body: string; hash: string; sources: string[] };
export type RoleSkill = { id: string; on: boolean; locked: boolean };
export type Role = {
  id: string;
  department: TemplateKey;
  kind: 'head' | 'member';
  title: Lang;
  description: Lang;
  tier: 'deep' | 'standard' | 'fast';
  perProduct: boolean;
  inDefault: boolean;
  skills: RoleSkill[];
  body: string;
  hash: string;
};
export type Templates = { roles: Map<string, Role>; skills: Map<string, Skill>; roster(key: TemplateKey): Role[] };

/* Every employee has these, locked on. */
export const CORE_SKILLS = ['hh-report-to-head', 'hh-outside-is-data', 'hh-verify-before-done', 'hh-ask-dont-guess', 'hh-stay-in-scope'] as const;
/* Every head has these too, locked on. */
export const HEAD_SKILLS = ['hh-break-down', 'hh-brief-members', 'hh-handle-reports', 'hh-fix-loop', 'hh-status-update'] as const;

/* Strict, so a value that YAML split on a comma fails instead of loading half. */
const LangText = z.object({ en: z.string().trim().min(1), ru: z.string().trim().min(1) }).strict();
const SkillHead = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  title: LangText,
  description: LangText,
  kind: z.enum(['core', 'procedure', 'checklist', 'gate']),
  sources: z.array(z.string().min(1)).default([]),
});
const RoleHead = z.object({
  id: z.string().regex(/^[A-Z]{3}-[A-Z0-9]+$/),
  department: z.enum(TEMPLATE_KEYS),
  kind: z.enum(['head', 'member']),
  title: LangText,
  description: LangText,
  tier: z.enum(['deep', 'standard', 'fast']),
  perProduct: z.boolean().default(false),
  default: z.boolean().default(true),
  /* Where the role stands in its roster, after the head. */
  order: z.number().int().default(50),
  /* A plain id is on by default; { id, on: false } is offered but off. Core and head skills are added, not listed. */
  skills: z.array(z.union([z.string(), z.object({ id: z.string(), on: z.boolean() })])).default([]),
});

export const textHash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12);

/* A file is YAML frontmatter between --- lines, then the body. */
function readParts(file: string): { head: unknown; body: string } {
  const text = readFileSync(file, 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`${file} has no frontmatter.`);
  try {
    return { head: parse(match[1]!), body: match[2]!.trim() };
  } catch (err) {
    throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parsed<T>(schema: z.ZodType<T>, file: string, head: unknown): T {
  const res = schema.safeParse(head);
  if (!res.success) throw new Error(`${file}: ${res.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  return res.data;
}

/* A department without a folder has no roster yet. */
const markdown = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md')).sort() : []);

export function loadTemplates(dir: string): Templates {
  const skills = new Map<string, Skill>();
  for (const f of markdown(join(dir, 'skills'))) {
    const file = join(dir, 'skills', f);
    const { head, body } = readParts(file);
    const s = parsed(SkillHead, file, head);
    if (`${s.id}.md` !== f) throw new Error(`${file} must be named ${s.id}.md.`);
    skills.set(s.id, { ...s, body, hash: textHash(body) });
  }

  const roles = new Map<string, Role>();
  const order = new Map<string, number>();
  for (const key of TEMPLATE_KEYS) {
    for (const f of markdown(join(dir, 'roles', key))) {
      const file = join(dir, 'roles', key, f);
      const { head, body } = readParts(file);
      const r = parsed(RoleHead, file, head);
      if (r.department !== key) throw new Error(`${file} is in ${key} but says ${r.department}.`);
      const locked = [...CORE_SKILLS, ...(r.kind === 'head' ? HEAD_SKILLS : [])].map(id => ({ id, on: true, locked: true }));
      const listed = r.skills.map(s => (typeof s === 'string' ? { id: s, on: true, locked: false } : { ...s, locked: false }));
      for (const s of [...locked, ...listed]) if (!skills.has(s.id)) throw new Error(`${file} names the skill ${s.id}, which does not exist.`);
      order.set(r.id, r.order);
      roles.set(r.id, {
        id: r.id,
        department: r.department,
        kind: r.kind,
        title: r.title,
        description: r.description,
        tier: r.tier,
        perProduct: r.perProduct,
        inDefault: r.default,
        skills: [...locked, ...listed.filter(s => !locked.some(l => l.id === s.id))],
        body,
        hash: textHash(body),
      });
    }
  }

  /* The head first, then default members, then optional ones, each by its order. */
  const rank = (r: Role) => (r.kind === 'head' ? 0 : r.inDefault ? 1 : 2);
  return {
    roles,
    skills,
    roster: key =>
      [...roles.values()].filter(r => r.department === key).sort((a, b) => rank(a) - rank(b) || order.get(a.id)! - order.get(b.id)! || a.id.localeCompare(b.id)),
  };
}
