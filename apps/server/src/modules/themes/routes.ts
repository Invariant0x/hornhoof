/* HTTP routes of the themes a company installs from archives (docs/theme-archive.md):
   - GET    /api/themes                        (the installed themes, for anyone signed in to the company)
   - GET    /api/themes/:id/look               (an installed theme's look, fonts and world, for the screens to put it on)
   - POST   /api/themes                        (CEO only: uploads an archive, application/zip, and installs it)
   - DELETE /api/themes/:id                    (CEO only: deletes it, first turning it off when it is on)
   - GET    /api/themes/files/:id/:version/*   (one file it serves, only as the type its check gave it) */

import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { THEME_LIMITS, type ThemeProblem } from '@hornhoof/protocol/themes';
import { DEFAULT_COMPANY_THEME } from '@hornhoof/protocol/world';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requirePerson } from '../../auth/session.js';
import { companies } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { requireWorldCeo, setCompanyTheme } from '../world/routes.js';
import { checkThemeArchive } from './archive.js';
import { deleteTheme, installedThemeLook, installedThemes, installedVersion, installTheme, themeBase, themeFile } from './store.js';
import { webThemeCheck } from './web-check.js';
import { ArchiveRefused, fileSource } from './zip.js';

const ThemeId = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);
const Version = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
const FilePath = z.string().min(1).max(THEME_LIMITS.pathLength).regex(/^(?:[A-Za-z0-9_@-][A-Za-z0-9._@-]*\/)*[A-Za-z0-9_@-][A-Za-z0-9._@-]*$/);

const refused = (problem: ThemeProblem) =>
  new ApiError(422, 'validation', `The theme archive was refused: ${problem.code}${problem.path ? ` at ${problem.path}` : ''}.`, 'theme_refused', { problem });

/* Writes the upload to a file of its own, counting its bytes: one over the archive limit stops it there. */
async function saved(body: Readable, path: string): Promise<void> {
  let bytes = 0;
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      done(bytes > THEME_LIMITS.archiveBytes ? new ArchiveRefused({ code: 'archive_too_large' }) : null, chunk);
    },
  });
  await pipeline(body, counted, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
}

export function themeRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  app.get('/api/themes', async req => {
    const me = await requirePerson(req, db);
    return { themes: await installedThemes(db, me.companyId) };
  });

  app.get('/api/themes/:id/look', async req => {
    const me = await requirePerson(req, db);
    const { id } = z.object({ id: ThemeId }).parse(req.params);
    const look = await installedThemeLook(db, me.companyId, id);
    if (!look) throw new ApiError(404, 'not_found', 'No such theme is installed.');
    return look;
  });

  app.delete('/api/themes/:id', async req => {
    const me = await requirePerson(req, db);
    requireWorldCeo(me);
    const { id } = z.object({ id: ThemeId }).parse(req.params);
    const [company] = await db.select({ theme: companies.theme }).from(companies).where(eq(companies.id, me.companyId));
    if (company?.theme === id) await setCompanyTheme(ctx, me, DEFAULT_COMPANY_THEME);
    if (!(await deleteTheme(db, me.companyId, id))) throw new ApiError(404, 'not_found', 'No such theme is installed.');
    ctx.bus.publish(me.companyId, { type: 'org' });
    return { themes: await installedThemes(db, me.companyId) };
  });

  /* An archive comes as its raw bytes and goes to a file of its own as it comes: it is never held in memory whole. */
  void app.register(async upload => {
    upload.removeAllContentTypeParsers();
    upload.addContentTypeParser(['application/zip', 'application/x-zip-compressed', 'application/octet-stream'], (_req, body, done) => done(null, body));
    upload.post('/api/themes', { bodyLimit: THEME_LIMITS.archiveBytes }, async (req, reply) => {
      const me = await requirePerson(req, db);
      requireWorldCeo(me);
      const declared = Number(req.headers['content-length'] ?? 0);
      if (declared > THEME_LIMITS.archiveBytes) throw refused({ code: 'archive_too_large' });
      const folder = await mkdtemp(join(tmpdir(), 'hh-theme-'));
      try {
        const path = join(folder, 'theme.zip');
        await saved(req.body as Readable, path);
        const handle = await open(path, 'r');
        try {
          const web = await webThemeCheck();
          const theme = await checkThemeArchive(await fileSource(handle), web, manifest => themeBase(manifest.id, manifest.version));
          if ((await installedVersion(db, me.companyId, theme.manifest.id)) === theme.manifest.version) {
            throw new ApiError(409, 'conflict', `Version ${theme.manifest.version} of this theme is installed already.`, 'theme_same_version', { problem: { code: 'same_version', path: 'theme.json' } });
          }
          await installTheme(db, me.companyId, me.id, theme);
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error instanceof ArchiveRefused) throw refused(error.problem);
        throw error;
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
      ctx.bus.publish(me.companyId, { type: 'org' });
      reply.code(201);
      return { themes: await installedThemes(db, me.companyId) };
    });
  });

  /* A theme's file, served only as the type its check gave it, and never as a page: no type sniffing, nothing it may run
     or load. A version's files never change, so a browser keeps them. */
  app.get('/api/themes/files/:id/:version/*', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { id, version, '*': path } = z.object({ id: ThemeId, version: Version, '*': FilePath }).parse(req.params);
    const file = await themeFile(db, me.companyId, id, version, path);
    if (!file) throw new ApiError(404, 'not_found', 'No such file.');
    return reply
      .header('content-type', file.mediaType)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cross-origin-resource-policy', 'same-origin')
      .header('content-disposition', 'inline')
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(Buffer.from(file.bytes));
  });
}
