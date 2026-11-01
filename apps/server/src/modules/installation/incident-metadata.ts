import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Ctx } from '../../app.js';
import { internalCall } from '../../auth/internal.js';
import { requirePerson } from '../../auth/session.js';
import { loadConfig, type Config } from '../../config.js';
import { openPool, type Db } from '../../db/client.js';
import { jobs, tasks } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { jobMetadata, JOB_METADATA_MAX_ROWS, type JobMetadata } from '../jobs/views.js';
import { jobOf } from '../tools/mcp.js';

export const INCIDENT = Object.freeze({
  operation: 'installation.incident_metadata_read',
  taskId: '25256ddc-66ce-4a4d-9198-093fc4ca4fd6',
  agentId: '7f038470-9455-432f-a113-0d7f72bd87cd',
  from: '2026-11-01T00:17:00Z',
  to: '2026-11-01T00:30:03Z',
});

export type ProtectedInstallation = {
  companyId: string;
  commit: string;
  image: string;
  controlDir: string;
  approvedBundleSha256: string;
};

export type IncidentMetadataResult =
  | { jobs: JobMetadata[]; complete: true }
  | { error: { code: 'unauthorized' | 'unavailable' | 'conflict'; message: string } };

const OPERATION_TIMEOUT_MS = 2_000;
const CLEANUP_TIMEOUT_MS = 250;
const MAX_CHARACTERS = 28_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_US = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const JOB_KEYS = [
  'id',
  'kind',
  'status',
  'error',
  'subscription_id',
  'session_id',
  'instructions_hash',
  'created_by',
  'task_id',
  'created_at',
  'started_at',
  'finished_at',
  'prompt_characters',
  'prompt_md5',
  'empty_start',
  'recovery_prefix',
  'predecessor_before_window',
] as const;

const unauthorized = (): IncidentMetadataResult => ({ error: { code: 'unauthorized', message: 'This incident metadata read is not authorized.' } });
const unavailable = (): IncidentMetadataResult => ({ error: { code: 'unavailable', message: 'Incident metadata is temporarily unavailable.' } });
const conflict = (): IncidentMetadataResult => ({ error: { code: 'conflict', message: 'Incident metadata cannot be returned safely.' } });

class Refusal extends Error {
  constructor(readonly result: IncidentMetadataResult) {
    super();
  }
}

class Timeout extends Error {}

function remaining(deadline: number): number {
  const left = deadline - Date.now();
  if (left <= 0) throw new Timeout();
  return left;
}

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Timeout()), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function authorize(ctx: Ctx, installation: ProtectedInstallation, request: FastifyRequest, deadline: number): Promise<void> {
  if (internalCall(request)) throw new Refusal(unauthorized());
  try {
    if (request.headers.authorization !== undefined) {
      const current = await bounded(jobOf(ctx, request), remaining(deadline));
      if (current.agentKind !== 'orchestrator') throw new Refusal(unauthorized());
      const [bound] = await bounded(
        ctx.db
          .select({ companyId: jobs.companyId })
          .from(jobs)
          .innerJoin(tasks, and(eq(tasks.id, jobs.taskId), eq(tasks.companyId, jobs.companyId)))
          .where(and(eq(jobs.id, current.id), eq(jobs.agentId, current.agentId), eq(jobs.companyId, current.companyId), eq(jobs.taskId, INCIDENT.taskId), eq(jobs.status, 'running'))),
        remaining(deadline),
      );
      if (!bound || bound.companyId !== current.companyId || bound.companyId !== installation.companyId) throw new Refusal(unauthorized());
      return;
    }
    const owner = await bounded(requirePerson(request, ctx.db), remaining(deadline));
    if (owner.via || !owner.isOwner || owner.scopeKind !== 'company' || owner.status !== 'active' || owner.companyId !== installation.companyId) throw new Refusal(unauthorized());
    const [bound] = await bounded(ctx.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, INCIDENT.taskId), eq(tasks.companyId, owner.companyId))), remaining(deadline));
    if (!bound) throw new Refusal(unauthorized());
  } catch (error) {
    if (error instanceof Refusal) throw error;
    if (error instanceof Timeout) throw new Refusal(unavailable());
    if (error instanceof ApiError) throw new Refusal(unauthorized());
    throw new Refusal(unavailable());
  }
}

const sameConfig = (anchored: Config, effective: Config): boolean => {
  const keys = [
    'databaseUrl',
    'publicUrl',
    'port',
    'secureCookies',
    'webDist',
    'installScript',
    'nodeKey',
    'nodePingMs',
    'streamPingMs',
    'version',
    'commit',
    'migrations',
    'image',
    'registryUrl',
    'updateCheckMs',
    'controlDir',
    'templatesDir',
  ] as const;
  return anchored.secret.equals(effective.secret) && keys.every(key => anchored[key] === effective[key]);
};

const actualBundleSha256 = (): string => {
  const current = fileURLToPath(import.meta.url);
  const extension = current.endsWith('.ts') ? '.ts' : '.js';
  const hash = createHash('sha256');
  for (const name of [`incident-metadata-entrypoint${extension}`, `incident-metadata${extension}`]) {
    hash.update(readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url))));
    hash.update([0]);
  }
  return hash.digest('hex');
};

function verifyInstallation(ctx: Ctx, installation: ProtectedInstallation, env: NodeJS.ProcessEnv): Config {
  const anchored = ctx.config;
  if (anchored.commit !== installation.commit || anchored.image !== installation.image || anchored.controlDir !== installation.controlDir) throw new Refusal(unavailable());
  if (!/^[0-9a-f]{64}$/.test(installation.approvedBundleSha256) || actualBundleSha256() !== installation.approvedBundleSha256) throw new Refusal(unavailable());
  const effective = loadConfig(env);
  if (!effective.databaseUrl || !sameConfig(anchored, effective)) throw new Refusal(unavailable());
  return effective;
}

const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
const nullableUuid = (value: unknown): boolean => value === null || (typeof value === 'string' && UUID.test(value));
const timestamp = (value: unknown): boolean => typeof value === 'string' && UTC_US.test(value) && Number.isFinite(Date.parse(value));
const nullableTimestamp = (value: unknown): boolean => value === null || timestamp(value);

function metadataRow(value: unknown): JobMetadata {
  if (!value || typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Refusal(conflict());
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join('\0') !== [...JOB_KEYS].sort().join('\0')) throw new Refusal(conflict());
  if (
    typeof row.id !== 'string' ||
    !UUID.test(row.id) ||
    (row.kind !== 'test' && row.kind !== 'conversation') ||
    !['queued', 'running', 'done', 'failed'].includes(String(row.status)) ||
    !nullableString(row.error) ||
    typeof row.subscription_id !== 'string' ||
    !UUID.test(row.subscription_id) ||
    !nullableString(row.session_id) ||
    !nullableString(row.instructions_hash) ||
    !nullableUuid(row.created_by) ||
    !nullableUuid(row.task_id) ||
    !timestamp(row.created_at) ||
    !nullableTimestamp(row.started_at) ||
    !nullableTimestamp(row.finished_at) ||
    !Number.isInteger(row.prompt_characters) ||
    (row.prompt_characters as number) < 0 ||
    typeof row.prompt_md5 !== 'string' ||
    !/^[0-9a-f]{32}$/.test(row.prompt_md5) ||
    typeof row.empty_start !== 'boolean' ||
    typeof row.recovery_prefix !== 'boolean' ||
    typeof row.predecessor_before_window !== 'boolean' ||
    (row.kind !== 'conversation' && row.empty_start)
  ) {
    throw new Refusal(conflict());
  }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status as JobMetadata['status'],
    error: row.error,
    subscription_id: row.subscription_id,
    session_id: row.session_id,
    instructions_hash: row.instructions_hash,
    created_by: row.created_by as string | null,
    task_id: row.task_id as string | null,
    created_at: row.created_at,
    started_at: row.started_at as string | null,
    finished_at: row.finished_at as string | null,
    prompt_characters: row.prompt_characters as number,
    prompt_md5: row.prompt_md5,
    empty_start: row.empty_start,
    recovery_prefix: row.recovery_prefix,
    predecessor_before_window: row.predecessor_before_window,
  };
}

function metadataResult(value: unknown): IncidentMetadataResult {
  if (!Array.isArray(value) || value.length > JOB_METADATA_MAX_ROWS) throw new Refusal(conflict());
  const result = { jobs: value.map(metadataRow), complete: true } as const;
  if (JSON.stringify(result).length > MAX_CHARACTERS) throw new Refusal(conflict());
  return result;
}

async function readIncident(config: Config, deadline: number): Promise<IncidentMetadataResult> {
  const pool = openPool(config.databaseUrl!, () => {});
  const queryMs = Math.min(1_000, remaining(deadline));
  pool.options.connectionTimeoutMillis = Math.min(500, queryMs);
  pool.options.query_timeout = queryMs;
  pool.options.statement_timeout = queryMs;
  pool.options.idle_in_transaction_session_timeout = queryMs;
  pool.options.lock_timeout = Math.min(250, queryMs);
  let client: pg.PoolClient | undefined;
  let transaction = false;
  let result: IncidentMetadataResult = unavailable();
  try {
    client = await bounded(pool.connect(), remaining(deadline));
    await bounded(client.query('BEGIN READ ONLY'), remaining(deadline));
    transaction = true;
    await bounded(client.query('SET LOCAL statement_timeout = 1000'), remaining(deadline));
    await bounded(client.query('SET LOCAL lock_timeout = 250'), remaining(deadline));
    await bounded(client.query('SET LOCAL idle_in_transaction_session_timeout = 1000'), remaining(deadline));
    const db = drizzle(client) as unknown as Db;
    const rows = await bounded(jobMetadata(db, INCIDENT.agentId, INCIDENT.from, INCIDENT.to), remaining(deadline));
    result = metadataResult(rows);
  } catch (error) {
    result = error instanceof Refusal ? error.result : unavailable();
  } finally {
    if (client) {
      if (transaction) {
        try {
          await bounded(client.query('ROLLBACK'), CLEANUP_TIMEOUT_MS);
        } catch {
          result = unavailable();
        }
      }
      try {
        client.release();
      } catch {
        result = unavailable();
      }
    }
    try {
      await bounded(pool.end(), CLEANUP_TIMEOUT_MS);
    } catch {
      result = unavailable();
    }
  }
  return result;
}

export async function invokeIncidentMetadata(ctx: Ctx, installation: ProtectedInstallation, env: NodeJS.ProcessEnv, request: FastifyRequest): Promise<IncidentMetadataResult> {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  try {
    await authorize(ctx, installation, request, deadline);
    const config = verifyInstallation(ctx, installation, env);
    return await readIncident(config, deadline);
  } catch (error) {
    if (error instanceof Refusal) return error.result;
    return unavailable();
  }
}
