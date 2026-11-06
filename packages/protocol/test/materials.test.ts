import { describe, expect, it } from 'vitest';
import { MaterialInput, MaterialManifest, MaterialView, QuestionMaterials } from '../src/index.js';

const ID = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const HASH = 'a'.repeat(64);
const file = { kind: 'file', attachmentId: ID, name: 'Evidence.zip', expectedSHA: HASH };
const url = `/api/requests/${OTHER}/materials/${ID}/content`;
const image = { id: ID, kind: 'image', name: 'Approved display', state: 'available', contentUrl: url, downloadUrl: null, size: 20, sha256: HASH, mediaType: 'image/png' };

const inputs = [
  file, { kind: 'image', attachmentId: ID, name: 'Preview.png' },
  ...['text', 'markdown', 'pdf'].map(format => ({ kind: 'document', format, attachmentId: ID, name: 'Document' })),
  { kind: 'link', name: 'Published evidence', url: 'https://example.com/evidence' },
];

describe('untrusted material input', () => {
  it.each(inputs)('accepts explicit $kind/$format references', value => {
    expect(MaterialInput.parse(value)).toEqual(value);
  });
  it.each(['role', 'canRead', 'canAnswer', 'mime', 'size', 'disclosureReceipt', 'native_record', 'sourceRef', 'id'])('rejects caller-owned %s fields', field => {
    expect(MaterialInput.safeParse({ ...file, [field]: true }).success).toBe(false);
  });
  it.each([
    { ...file, attachmentId: 'not-uuid' }, { ...file, expectedSHA: 'A'.repeat(64) },
    { ...file, name: '' }, { ...file, name: 'line\r\nbreak' }, { ...file, name: '\ud800' },
    { ...file, name: 'é'.repeat(101) }, { ...file, kind: 'native_record' },
    { kind: 'document', format: 'html', attachmentId: ID, name: 'Document' },
  ])('rejects invalid file references %#', value => expect(MaterialInput.safeParse(value).success).toBe(false));
  it.each(['http://example.com/', 'javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'https://a:b@example.com/', 'https://EXAMPLE.com', 'https://example.com/\n'])('rejects unsafe/noncanonical link %s', value => {
    expect(MaterialInput.safeParse({ kind: 'link', name: 'Link', url: value }).success).toBe(false);
  });
});

describe('result and action presentations', () => {
  it.each([
    { presentation: 'action', common: [], options: [] },
    { presentation: 'action', common: [], options: [[], []] },
    { presentation: 'result', common: [file], options: [] },
    { presentation: 'result', common: [], options: [[file], [inputs[1]]] },
  ])('accepts valid $presentation %#', value => expect(QuestionMaterials.parse(value)).toEqual(value));
  it.each([
    { presentation: 'result', common: [], options: [] },
    { presentation: 'result', common: [file], options: [[]] },
    { presentation: 'result', common: [], options: [[file], []] },
    { presentation: 'legacy', common: [], options: [] },
    { presentation: 'action', common: [], options: [], canAnswer: true },
    { presentation: 'action', common: Array(7).fill(file), options: [] },
    { presentation: 'action', common: [], options: Array(5).fill([]) },
  ])('refuses missing result coverage or forged presentation %#', value => expect(QuestionMaterials.safeParse(value).success).toBe(false));
});

describe('safe public views', () => {
  it('projects image original and optional guarded download without a thumb', () => {
    expect(MaterialView.parse(image)).toEqual(image);
    expect(MaterialView.parse({ ...image, downloadUrl: url.replace('/content', '/download') })).toEqual({ ...image, downloadUrl: url.replace('/content', '/download') });
  });
  it.each(['text', 'markdown', 'pdf'])('accepts complete %s document metadata', format => {
    const document = { ...image, kind: 'document', format, mediaType: { text: 'text/plain', markdown: 'text/markdown', pdf: 'application/pdf' }[format] };
    expect(MaterialView.parse(document)).toEqual(document);
  });
  it('accepts proposal sources and permitted raster formats', () => {
    for (const mediaType of ['image/jpeg', 'image/webp']) {
      const value = { ...image, mediaType, contentUrl: url.replace('/requests/', '/proposals/') };
      expect(MaterialView.parse(value)).toEqual(value);
    }
  });
  it.each(['denied', 'missing', 'unsupported'])('keeps %s free of private metadata', state => {
    const value = { id: ID, kind: 'image', name: 'Unavailable material', state };
    expect(MaterialView.parse(value)).toEqual(value);
    expect(MaterialView.safeParse({ ...value, contentUrl: url }).success).toBe(false);
  });
  it('accepts available file and deliberate HTTPS link', () => {
    const binary = { ...image, kind: 'file', mediaType: 'application/zip' };
    expect(MaterialView.parse(binary)).toEqual(binary);
    const link = { id: ID, kind: 'link', name: 'Evidence', state: 'available', url: 'https://example.com/' };
    expect(MaterialView.parse(link)).toEqual(link);
  });
  it.each([
    { ...image, thumb: url }, { ...image, attachmentId: OTHER }, { ...image, sourceRef: OTHER },
    { ...image, contentUrl: 'https://other.example/content' }, { ...image, contentUrl: '//other.example/content' },
    { ...image, contentUrl: url + '?token=no' }, { ...image, contentUrl: url.replace(ID, OTHER) },
    { ...image, contentUrl: url + '/..' }, { ...image, mediaType: 'image/svg+xml' },
    { ...image, size: -1 }, { ...image, size: 3 * 1024 * 1024 + 1 },
    { ...image, downloadUrl: url.replace('/requests/', '/proposals/').replace('/content', '/download') },
    { ...image, kind: 'document', format: 'pdf', mediaType: 'text/html' },
  ])('refuses unsafe projection %#', value => expect(MaterialView.safeParse(value).success).toBe(false));
  it('keeps common and ordered option materials explicit without source references', () => {
    const manifest = { materialRevision: 1, materialDigest: HASH, common: [image], options: [{ id: OTHER, materials: [] }] };
    expect(MaterialManifest.parse(manifest)).toEqual(manifest);
    expect(MaterialManifest.safeParse({ ...manifest, sourceRef: { kind: 'task_request', id: ID } }).success).toBe(false);
    expect(MaterialManifest.safeParse({ ...manifest, materialRevision: 0 }).success).toBe(false);
  });
});

describe('bounded contract metadata', () => {
  it('refuses oversized input envelopes without changing file byte limits', () => {
    const link = { kind: 'link', name: 'n'.repeat(200), url: 'https://example.com/' + 'x'.repeat(1900) };
    expect(MaterialInput.parse(link)).toEqual(link);
    expect(QuestionMaterials.safeParse({ presentation: 'action', common: Array(6).fill(link), options: Array(4).fill(Array(6).fill(link)) }).success).toBe(false);
  });
  it('refuses wrong kind MIME and unavailable metadata for each kind', () => {
    expect(MaterialView.safeParse({ ...image, kind: 'file', size: 50 * 1024 * 1024 + 1 }).success).toBe(false);
    expect(MaterialView.safeParse({ ...image, mediaType: 'image/png\r\nX-Test: unsafe' }).success).toBe(false);
    for (const kind of ['file', 'link', 'document']) {
      const base = { id: ID, kind, name: 'Unavailable material', state: 'missing', ...(kind === 'document' ? { format: 'pdf' } : {}) };
      expect(MaterialView.parse(base)).toEqual(base);
      expect(MaterialView.safeParse({ ...base, attachmentId: OTHER }).success).toBe(false);
    }
  });
});


describe('legacy public material compatibility', () => {
  const legacyImages = Array.from({ length: 6 }, (_, n) => {
    const id = `00000000-0000-4000-8000-${String(n + 10).padStart(12, '0')}`;
    return { ...image, id, contentUrl: `/api/requests/${OTHER}/materials/${id}/content` };
  });
  const links = [
    { id: ID, kind: 'link', name: 'Original link', state: 'available', url: 'https://example.com/evidence' },
    { id: OTHER, kind: 'link', name: 'Commit', state: 'available', url: `https://github.com/example/repo/commit/${'a'.repeat(40)}` },
  ];
  it.each([1, 2])('retains six legacy images and %s independent links in the public manifest', count => {
    const manifest = { materialRevision: 1, materialDigest: HASH, common: [...legacyImages, ...links.slice(0, count)], options: [] };
    expect(MaterialManifest.parse(manifest)).toEqual(manifest);
  });
  it('still refuses nine public common materials', () => {
    expect(MaterialManifest.safeParse({ materialRevision: 1, materialDigest: HASH, common: [...legacyImages, ...links, image], options: [] }).success).toBe(false);
  });
  it('keeps new input and per-option output bounds at six', () => {
    expect(QuestionMaterials.safeParse({ presentation: 'action', common: Array(7).fill(file), options: [] }).success).toBe(false);
    expect(MaterialManifest.safeParse({ materialRevision: 1, materialDigest: HASH, common: [], options: [{ id: OTHER, materials: [...legacyImages, image] }] }).success).toBe(false);
  });
});
