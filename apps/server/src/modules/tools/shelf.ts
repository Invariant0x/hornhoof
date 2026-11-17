import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PRIVATE_TOOLS } from '@hornhoof/protocol';
import { getParseErrorMessage, normalizeObjectSchema, safeParseAsync } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { departments } from '../../db/schema.js';
import { deptName } from '../departments/templates.js';
import type { ToolJob } from './job.js';

/* The orchestrator is above every agent of Hornhoof and does whatever any of them can (Ivan's word of 16 November 2026).
   Its everyday tools are on its list as ever; every other tool any agent has waits on its shelf, off the list, by name and
   one line, until it finds one, reads it whole and calls it. A tool a department's own head works with goes for the
   department the orchestrator names. */

type Answer = { content: { type: 'text'; text: string }[]; isError?: boolean };
type Kept = { tool: RegisteredTool; shelved: boolean; department: boolean };
type Handler = (...given: unknown[]) => Answer | Promise<Answer>;

const say = (text: string, isError = false): Answer => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });
const firstLine = (text = '') => text.split(/(?<=\.)\s/)[0]!.slice(0, 300);
export const FIND = 'find_tool';
export const USE = 'use_tool';

/* The job a call of use_tool runs as: the orchestrator's own, in the department it names. */
export function actingFor(job: ToolJob, body: unknown): ToolJob {
  const call = body as { method?: unknown; params?: { name?: unknown; arguments?: { department?: unknown } } } | null;
  const department = call?.method === 'tools/call' && call.params?.name === USE ? call.params.arguments?.department : undefined;
  return job.agentKind === 'orchestrator' && typeof department === 'string' ? { ...job, departmentId: department } : job;
}

export class Shelf {
  private readonly tools = new Map<string, Kept>();
  private mode: 'list' | 'shelf' | 'department' = 'list';
  private readonly use: RegisteredTool;

  /* Before any other tool is registered, so that it keeps every one of them, and with nothing over its own two: what they
     call runs under the guards of the tool itself. */
  constructor(server: McpServer, private readonly ctx: Ctx, private readonly job: ToolJob) {
    server.registerTool(
      FIND,
      {
        description:
          'Finds any tool of Hornhoof, yours or any other agent\'s. With query: the names and first lines of the tools whose name or description has every word of it; with nothing: all of them. ' +
          'With name: that tool whole, its description and the input it takes, to call with use_tool.',
        inputSchema: { query: z.string().trim().max(200).optional(), name: z.string().trim().max(100).optional() },
      },
      async ({ query, name }) => (name ? this.load(name) : this.find(query ?? '')),
    );
    this.use = server.registerTool(
      PRIVATE_TOOLS.delegate.name,
      {
        _meta: PRIVATE_TOOLS.delegate._meta,
        description: 'Calls any tool of Hornhoof by its name with its input, as yours.',
        inputSchema: {
          name: z.string().trim().min(1).max(100),
          arguments: z.record(z.string(), z.unknown()).optional().describe('The input of the tool, as find_tool shows it.'),
          department: z.uuid().optional().describe("The department you act for, for a tool that works on a department's own."),
        },
      },
      async ({ name, arguments: given }, extra) => this.call(name, given, extra),
    );
    const register = server.registerTool.bind(server) as (name: string, config: unknown, handler: Handler) => RegisteredTool;
    server.registerTool = ((name: string, config: unknown, handler: Handler) => {
      const known = this.tools.get(name);
      /* A tool the orchestrator has of its own goes for the same one of another agent. */
      if (known && this.mode !== 'list') return known.tool;
      const tool = register(name, config, handler);
      this.tools.set(name, { tool, shelved: this.mode !== 'list', department: this.mode === 'department' });
      return tool;
    }) as McpServer['registerTool'];
  }

  /* From here on, the tools registered go on the shelf; with department, they work on a department's own. */
  shelve(department = false): void {
    this.mode = department ? 'department' : 'shelf';
  }

  /* The shelf's names go into use_tool's description; on a list they stay off it. */
  close(listing: boolean): void {
    const shelved = [...this.tools].filter(([, kept]) => kept.shelved);
    this.use.update({ description: `Calls any tool of Hornhoof by its name with its input, as yours. Besides those on your list, there are: ${shelved.map(([name]) => name).join(', ')}.` });
    if (listing) for (const [, kept] of shelved) kept.tool.disable();
  }

  private find(query: string): Answer {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const lines = [...this.tools]
      .filter(([name, { tool }]) => words.every(word => `${name} ${tool.description ?? ''}`.toLowerCase().includes(word)))
      .map(([name, { tool }]) => `${name}: ${firstLine(tool.description)}`);
    return say(lines.length ? lines.join('\n') : `No tool has every word of "${query}". Try fewer words, or none for all of them.`);
  }

  private load(name: string): Answer {
    const kept = this.tools.get(name);
    if (!kept) return say(this.unknown(name), true);
    const schema = normalizeObjectSchema(kept.tool.inputSchema);
    const inputSchema = schema ? toJsonSchemaCompat(schema, { strictUnions: true, pipeStrategy: 'input' }) : { type: 'object', properties: {} };
    return say(JSON.stringify({ name, description: kept.tool.description, inputSchema, ...(kept.department ? { department: 'required' } : {}) }));
  }

  private unknown(name: string): string {
    const near = [...this.tools.keys()].filter(other => other.includes(name.slice(0, 4)) || name.includes(other));
    return `There is no tool ${name}.${near.length ? ` Near it: ${near.join(', ')}.` : ''} find_tool lists them all.`;
  }

  private async call(name: string, given: Record<string, unknown> | undefined, extra: unknown): Promise<Answer> {
    const kept = this.tools.get(name);
    if (!kept || name === USE) return say(this.unknown(name), true);
    if (kept.department && !(await this.inDepartment())) return say(await this.departments(name), true);
    const { tool } = kept;
    const schema = normalizeObjectSchema(tool.inputSchema);
    if (!schema) return (tool.handler as Handler)(extra);
    const parsed = await safeParseAsync(schema, given ?? {});
    if (!parsed.success) return say(`The input of ${name} is not right: ${getParseErrorMessage(parsed.error)}. find_tool with its name shows what it takes.`, true);
    return (tool.handler as Handler)(parsed.data, extra);
  }

  /* Whether the call names a department of this company. */
  private async inDepartment(): Promise<boolean> {
    if (!this.job.departmentId) return false;
    const [found] = await this.ctx.db.select({ id: departments.id }).from(departments).where(and(eq(departments.id, this.job.departmentId), eq(departments.companyId, this.job.companyId)));
    return Boolean(found);
  }

  private async departments(name: string): Promise<string> {
    const all = await this.ctx.db
      .select()
      .from(departments)
      .where(and(eq(departments.companyId, this.job.companyId), isNull(departments.parentId)))
      .orderBy(asc(departments.position), asc(departments.createdAt));
    return `${name} works on one department: name the one you act for in department. Nothing was changed. The departments:\n${all.map(d => `${d.id} ${deptName(d)}`).join('\n')}`;
  }
}
