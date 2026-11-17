import { z } from 'zod';

/* Metadata only: current source/file authority is checked by the server on every
   read. A UUID, parser result, URL or disclosure record is never a grant. */
export const MATERIAL_LIMITS = { nameBytes: 200, urlBytes: 2048, metadataBytes: 32768, historyBytes: 1048576, perList: 6, options: 4 } as const;
const UTF8 = new TextEncoder();
const UUID = z.uuid();
const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Size = z.number().int().nonnegative().max(50 * 1024 * 1024);
const Format = z.enum(['text', 'markdown', 'pdf']);
const Mime = z.string().min(1).max(127).regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/);
const Name = z.string().min(1).max(MATERIAL_LIMITS.nameBytes).refine(value => validText(value, MATERIAL_LIMITS.nameBytes), 'Invalid material name.');

function validText(value: string, bytes: number): boolean {
  return !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value) && UTF8.encode(value).length <= bytes;
}
export function materialMetadataFits(value: unknown): boolean {
  return UTF8.encode(JSON.stringify(value)).length <= MATERIAL_LIMITS.metadataBytes;
}
function canonicalHttps(value: string): boolean {
  if (!validText(value, MATERIAL_LIMITS.urlBytes)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.href === value;
  } catch { return false; }
}
const Https = z.string().min(1).max(MATERIAL_LIMITS.urlBytes).refine(canonicalHttps, 'Expected canonical HTTPS without credentials.');
const fileInput = { attachmentId: UUID, name: Name, expectedSHA: Digest.optional() };
export const MaterialInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('image'), ...fileInput }),
  z.strictObject({ kind: z.literal('document'), format: Format, ...fileInput }),
  z.strictObject({ kind: z.literal('file'), ...fileInput }),
  z.strictObject({ kind: z.literal('link'), name: Name, url: Https }),
]);
export type MaterialInput = z.infer<typeof MaterialInput>;
export const MaterialSourceRef = z.strictObject({ kind: z.enum(['task_request', 'proposal']), id: UUID });
export type MaterialSourceRef = z.infer<typeof MaterialSourceRef>;

const ROUTE = /^\/api\/(requests|proposals)\/([0-9a-f-]+)\/materials\/([0-9a-f-]+)\/content$/;
function scopedContent(value: string): boolean {
  const match = ROUTE.exec(value);
  return !!match && UUID.safeParse(match[2]).success && UUID.safeParse(match[3]).success;
}
const ContentUrl = z.string().max(MATERIAL_LIMITS.urlBytes).refine(scopedContent, 'Expected a scoped material content route.');
const binaryView = { contentUrl: ContentUrl, downloadUrl: z.string().max(MATERIAL_LIMITS.urlBytes).nullable(), size: Size, sha256: Digest, mediaType: Mime };
const viewBase = { id: UUID, name: Name };
const unavailable = z.enum(['denied', 'missing', 'unsupported']);
const imageAvailable = z.strictObject({ ...viewBase, kind: z.literal('image'), state: z.literal('available'), ...binaryView, size: z.number().int().nonnegative().max(3 * 1024 * 1024), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']) });
const documentAvailable = z.strictObject({ ...viewBase, kind: z.literal('document'), format: Format, state: z.literal('available'), ...binaryView });
const fileAvailable = z.strictObject({ ...viewBase, kind: z.literal('file'), state: z.literal('available'), ...binaryView });
const linkAvailable = z.strictObject({ ...viewBase, kind: z.literal('link'), state: z.literal('available'), url: Https });
const viewSchema = z.discriminatedUnion('kind', [
  z.discriminatedUnion('state', [imageAvailable, z.strictObject({ ...viewBase, kind: z.literal('image'), state: unavailable })]),
  z.discriminatedUnion('state', [documentAvailable, z.strictObject({ ...viewBase, kind: z.literal('document'), format: Format, state: unavailable })]),
  z.discriminatedUnion('state', [fileAvailable, z.strictObject({ ...viewBase, kind: z.literal('file'), state: unavailable })]),
  z.discriminatedUnion('state', [linkAvailable, z.strictObject({ ...viewBase, kind: z.literal('link'), state: unavailable })]),
]);
const DOCUMENT_MIME = { text: 'text/plain', markdown: 'text/markdown', pdf: 'application/pdf' } as const;
function validView(value: z.infer<typeof viewSchema>): boolean {
  if (value.state !== 'available' || value.kind === 'link') return true;
  const route = ROUTE.exec(value.contentUrl);
  if (!route || route[3] !== value.id) return false;
  if (value.downloadUrl !== null && value.downloadUrl !== value.contentUrl.replace(/\/content$/, '/download')) return false;
  return value.kind !== 'document' || value.mediaType === DOCUMENT_MIME[value.format];
}
export const MaterialView = viewSchema.refine(validView, 'Mismatched material identity, route or document type.');
export type MaterialView = z.infer<typeof MaterialView>;
export const MaterialManifest = z.strictObject({
  materialRevision: Revision, materialDigest: Digest,
  // Legacy questions may carry six images plus their link and commit URL.
  common: z.array(MaterialView).max(MATERIAL_LIMITS.perList + 2),
  options: z.array(z.strictObject({ id: UUID, materials: z.array(MaterialView).max(MATERIAL_LIMITS.perList) })).max(MATERIAL_LIMITS.options),
}).refine(materialMetadataFits, 'Oversized material metadata.');
export type MaterialManifest = z.infer<typeof MaterialManifest>;

/* Private service DTOs. The server seals exact bytes, appends immutable versions and
   validates ownership, current revisions and disclosure provenance. Never accept
   these as caller input or serialize them through a public row projection. */
type MaterialDisclosureBinding = {
  id: string; materialId: string; fileId: string; sha256: string; sourceRevision: number;
  purpose: 'decision_material'; recipientPersonIds: string[]; routeRevision: number;
  authorityRevision: number; issuerAgentId: string;
};
type AttachmentBacking = { kind: 'attachment'; attachmentId: string; sha256: string; size: number; mediaType: string };
type NativeBacking = { kind: 'native_record'; utf8: string; sha256: string };
type SealedMaterial = { id: string; name: string } & (
  | { kind: 'image' | 'file'; backing: AttachmentBacking }
  | { kind: 'document'; format: 'text'; backing: AttachmentBacking | NativeBacking }
  | { kind: 'document'; format: 'markdown' | 'pdf'; backing: AttachmentBacking }
  | { kind: 'link'; backing: { kind: 'link'; url: string } }
);
type MaterialSnapshot = {
  schemaVersion: 1; sourceRef: MaterialSourceRef; sourceRevision: number; requestRevision: number | null;
  materialRevision: number; digest: string; common: SealedMaterial[];
  options: { id: string; materials: SealedMaterial[] }[]; explicitDisclosureBindings: MaterialDisclosureBinding[];
};
export type MaterialSnapshotHistory = { schemaVersion: 1; versions: MaterialSnapshot[] };
