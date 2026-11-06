import { createHash } from 'node:crypto';
import { MaterialManifest, MaterialView, QuestionMaterials } from '@hornhoof/protocol';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requirePerson, type Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { attachments } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { commitUrl, PICTURE_BYTES, pictureType, sendFile } from './attachments.js';
import { materialRequest, requireLegacyMaterials, type MaterialRequest } from './material-access.js';

const PIECE_BYTES = 1024 * 1024;
const SourceParams = z.strictObject({ id: z.uuid() });
const ContentParams = SourceParams.extend({ materialId: z.uuid() });
type Picture = { id: string; mediaType: string; length: number; prefix: Uint8Array };
type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';
type Target = { id: string; name: string; length: number; mediaType: ImageType };
type Collection = { manifest: MaterialManifest; files: Map<string, Target> };

const ATTACH_HINT = 'Upload the files with hh-attach --task <task number> FILE, then pass the returned attachment ids or HTTPS links in materials.common and each corresponding materials.options list.';

/* Metadata validation only. The requirement and option count come from the
   actual source; a parsed result is no classification or disclosure grant. */
export function parseMaterialSubmission(input: unknown, optionCount: number, resultRequired: boolean): QuestionMaterials | undefined {
  if (input === undefined) {
    if (resultRequired) throw new ApiError(400, 'validation', `materials_required: Attach the result materials. ${ATTACH_HINT}`, 'materials_required', { field: 'materials', howToAttach: ATTACH_HINT });
    return undefined;
  }
  const parsed = QuestionMaterials.safeParse(input);
  if (!parsed.success) {
    const reason = parsed.error.issues.some(issue => issue.code === 'custom' && issue.message.startsWith('materials_required:')) ? 'materials_required' : 'materials_invalid';
    throw new ApiError(400, 'validation', `${reason}: ${parsed.error.issues.map(issue => issue.message).join(' ')} ${ATTACH_HINT}`, reason, { fields: parsed.error.issues.map(issue => issue.path), howToAttach: ATTACH_HINT });
  }
  if (resultRequired && parsed.data.presentation !== 'result') throw new ApiError(400, 'validation', `materials_required: This source presents a result. ${ATTACH_HINT}`, 'materials_required', { field: 'materials.presentation', howToAttach: ATTACH_HINT });
  if (parsed.data.options.length !== optionCount) throw new ApiError(400, 'validation', `materials_invalid: Match the material lists to the source options in order. ${ATTACH_HINT}`, 'materials_invalid', { field: 'materials.options', howToAttach: ATTACH_HINT });
  return parsed.data;
}

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/* Stable selectors for existing immutable records, not exposed attachment ids. */
function materialId(sourceId: string, slot: string): string {
  const value = digest(`hornhoof-material-v1:${sourceId}:${slot}`);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-8${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

/* Hash bounded pieces under the same source binding; no complete file is kept
   in a manifest, and a file removed during the read is not called available. */
async function pictureDigest(db: Db, source: MaterialRequest, file: Picture): Promise<string | null> {
  const hash = createHash('sha256');
  for (let at = 0; at < file.length; at += PIECE_BYTES) {
    const [part] = await db.select({ bytes: sql<Uint8Array>`substring(${attachments.bytes} from ${at + 1} for ${PIECE_BYTES})` }).from(attachments)
      .where(and(eq(attachments.id, file.id), eq(attachments.requestId, source.request.id), eq(attachments.companyId, source.request.companyId), isNull(attachments.operatorCaseId)));
    if (!part || part.bytes.length !== Math.min(PIECE_BYTES, file.length - at)) return null;
    hash.update(part.bytes);
  }
  return hash.digest('hex');
}

async function imageView(db: Db, source: MaterialRequest, id: string, slot: string, ordinal: number, file: Picture | undefined, files: Map<string, Target>): Promise<MaterialView> {
  const base = { kind: 'image' as const, id: materialId(source.request.id, `${slot}:${id}`), name: `Image ${ordinal}` };
  if (!file) return { ...base, state: 'missing' };
  const type = pictureType(Buffer.from(file.prefix));
  if (!type || type !== file.mediaType || file.length > PICTURE_BYTES) return { ...base, state: 'unsupported' };
  const sha256 = await pictureDigest(db, source, file);
  if (!sha256) return { ...base, state: 'missing' };
  const contentUrl = `/api/requests/${source.request.id}/materials/${base.id}/content`;
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[type];
  files.set(base.id, { id, name: `${base.name}.${extension}`, length: file.length, mediaType: type });
  return { ...base, state: 'available', contentUrl, downloadUrl: contentUrl.replace(/\/content$/, '/download'), size: file.length, sha256, mediaType: type };
}

function linkView(sourceId: string, slot: string, name: string, raw: string): MaterialView {
  const base = { kind: 'link' as const, id: materialId(sourceId, slot), name };
  const available = { ...base, state: 'available' as const, url: URL.canParse(raw) ? new URL(raw).href : raw };
  return MaterialView.safeParse(available).success ? available : { ...base, state: 'unsupported' };
}

async function optionViews(db: Db, source: MaterialRequest, pictures: Map<string, Picture>, files: Map<string, Target>): Promise<MaterialManifest['options']> {
  const result: MaterialManifest['options'] = [];
  for (const [index, option] of source.request.options.entries()) {
    const materials = option.image ? [await imageView(db, source, option.image, `option:${index}`, index + 1, pictures.get(option.image), files)] : [];
    result.push({ id: materialId(source.request.id, `option:${index}`), materials });
  }
  return result;
}

/* Addressed-only picture permission does not reveal hidden repository links. */
async function legacyLinks(db: Db, source: MaterialRequest): Promise<MaterialView[]> {
  if (!source.known) return [];
  const result: MaterialView[] = [];
  if (source.request.link) result.push(linkView(source.request.id, 'link', 'Result', source.request.link));
  const commit = await commitUrl(db, source.task, source.request.commit);
  if (commit) result.push(linkView(source.request.id, 'commit', 'Commit', commit));
  return result;
}

async function legacyCollection(db: Db, source: MaterialRequest): Promise<Collection> {
  await requireLegacyMaterials(db, source);
  const { request } = source;
  const pictures = await db.select({ id: attachments.id, mediaType: attachments.mediaType, length: sql<number>`octet_length(${attachments.bytes})`.mapWith(Number), prefix: sql<Uint8Array>`substring(${attachments.bytes} from 1 for 12)` })
    .from(attachments).where(and(eq(attachments.requestId, request.id), eq(attachments.companyId, request.companyId), eq(attachments.agentId, request.agentId), isNull(attachments.personId), isNull(attachments.taskId), isNull(attachments.operatorCaseId)))
    .orderBy(asc(attachments.createdAt), asc(attachments.id));
  const byId = new Map(pictures.map(file => [file.id, file]));
  const inOptions = new Set(request.options.flatMap(option => option.image ? [option.image] : []));
  const files = new Map<string, Target>();
  const common: MaterialView[] = [];
  for (const file of pictures.filter(file => !inOptions.has(file.id))) common.push(await imageView(db, source, file.id, 'common', common.length + 1, file, files));
  const options = await optionViews(db, source, byId, files);
  common.push(...await legacyLinks(db, source));
  const materialDigest = digest(JSON.stringify({ common, options }));
  return { manifest: MaterialManifest.parse({ materialRevision: 1, materialDigest, common, options }), files };
}

export async function projectMaterials(ctx: Pick<Ctx, 'db'>, me: Person, requestId: string): Promise<MaterialManifest> {
  return (await legacyCollection(ctx.db, await materialRequest(ctx.db, me, requestId))).manifest;
}

export async function readMaterialContent(ctx: Pick<Ctx, 'db'>, me: Person, requestId: string, id: string, download: boolean, reply: FastifyReply): Promise<FastifyReply> {
  const collection = await legacyCollection(ctx.db, await materialRequest(ctx.db, me, requestId));
  const found = collection.files.get(id);
  if (!found) throw new ApiError(404, 'not_found', 'There is no such material.', 'attachment_unknown');
  reply.header('cache-control', 'private, no-store').header('content-disposition', `${download ? 'attachment' : 'inline'}; filename="${found.name}"`);
  return sendFile(ctx.db, reply, { ...found, ...(download ? {} : { inlineType: found.mediaType }) });
}

export function materialRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/requests/:id/materials', async (req, reply) => {
    const me = await requirePerson(req, ctx.db);
    const { id } = SourceParams.parse(req.params);
    reply.header('cache-control', 'private, no-store');
    return projectMaterials(ctx, me, id);
  });
  for (const mode of ['content', 'download'] as const) app.get(`/api/requests/:id/materials/:materialId/${mode}`, async (req, reply) => {
    const me = await requirePerson(req, ctx.db);
    const { id, materialId: item } = ContentParams.parse(req.params);
    return readMaterialContent(ctx, me, id, item, mode === 'download', reply);
  });
}
