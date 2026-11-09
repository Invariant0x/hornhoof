import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { hashToken } from '../crypto/tokens.js';
import { applyMissingMigrations, MIGRATIONS, type Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { compareSnapshots, requestStats, Snapshot, testTimings } from './report.js';

const { values } = parseArgs({ options: { output: { type: 'string' }, baseline: { type: 'string' }, timings: { type: 'string', multiple: true }, samples: { type: 'string', default: '15' }, threshold: { type: 'string', default: '20' }, commit: { type: 'string', default: '' } } });
const samples = Number(values.samples);
if (!Number.isInteger(samples) || samples < 3 || samples > 1000) throw new Error('samples must be an integer from 3 to 1000.');
const previous = values.baseline ? Snapshot.parse((JSON.parse(readFileSync(values.baseline, 'utf8')) as { snapshot?: unknown }).snapshot ?? JSON.parse(readFileSync(values.baseline, 'utf8'))) : null;
const tests = testTimings((values.timings ?? []).map(file => ({ name: basename(file), log: readFileSync(file, 'utf8') })));
const failedRequests: { method: string; url: string; statusCode: number; errors: number }[] = [];
const started = performance.now();
const client = new PGlite();
const db = drizzle(client, { schema });
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
try {
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await applyMissingMigrations(db, { migrationsFolder: MIGRATIONS });
  const [company] = await db.insert(schema.companies).values({ name: 'Benchmark fixture' }).returning();
  const [person] = await db.insert(schema.people).values({ companyId: company!.id, name: 'Benchmark reader', email: 'reader@benchmark.invalid', status: 'active', scopeKind: 'company', isOwner: true }).returning();
  const token = 'benchmark-local-session';
  await db.insert(schema.sessions).values({ tokenHash: hashToken(token), personId: person!.id, expiresAt: new Date(Date.now() + 600_000) });
  const dbSetupMs = performance.now() - started;
  const beforeApp = performance.now();
  const config = loadConfig({ HORNHOOF_SECRET: Buffer.alloc(32, 8).toString('base64'), UPDATE_CHECK_MS: '0' });
  app = await buildApp({ db: db as unknown as Db, config, logger: false });
  await app.ready();
  const appReadyMs = performance.now() - beforeApp;
  const coldReadyMs = process.uptime() * 1000;
  const requests: Snapshot['requests'] = [];
  for (const url of ['/api/me', '/api/org', '/api/tasks?department=none']) {
    const times: number[] = [];
    for (let i = 0; i < samples; i++) {
      const from = performance.now();
      const response = await app.inject({ method: 'GET', url, cookies: { hh_session: token } });
      if (response.statusCode !== 200) {
        failedRequests.push({ method: 'GET', url, statusCode: response.statusCode, errors: 1 });
        throw new Error('Unexpected benchmark response.');
      }
      times.push(performance.now() - from);
    }
    requests.push({ method: 'GET', url, statusCode: 200, errors: 0, samples, ...requestStats(times) });
  }
  const { rss, heapUsed } = process.memoryUsage();
  const snapshot = Snapshot.parse({ version: 1, measuredAt: new Date().toISOString(), commit: values.commit, environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: availableParallelism(), database: 'pglite', samples }, coldReadyMs, appReadyMs, dbSetupMs, memory: { rss, heapUsed }, requests, tests });
  const report = { status: 'measured', snapshot, comparison: compareSnapshots(snapshot, previous, Number(values.threshold)), notes: ['Synthetic PGlite fixture + Fastify inject; no production PostgreSQL or network latency. Durations are ms; memory is bytes; measuredAt is ISO UTC; commit is a full SHA.', 'coldReadyMs: process start through imports, database init/migrations, fixture setup and app.ready(). appReadyMs: config/buildApp through app.ready(), excluding database setup. Requests use Fastify inject.', 'Test part totals sum file times; absence of timing inputs is missing, never zero. Regression reports are nonblocking.'] };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (values.output) writeFileSync(values.output, json);
  process.stdout.write(json);
} catch {
  process.stdout.write(`${JSON.stringify({ status: 'failed', reason: 'Benchmark did not complete; do not use partial latency samples.', requests: failedRequests })}\n`);
  process.exitCode = 1;
} finally {
  await app?.close();
  await client.close();
}
