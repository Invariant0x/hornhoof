import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { themeArchiveFiles } from '../scripts/theme-pack';

/* The archive of a built-in theme with a painted kit and its fonts brought from outside the repository (#1970): a kit's
   pictures and fonts have their own licence and never go into git (#84, #105), so the script takes them from folders
   on the machine that packs the theme. */

function folder(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'theme-pack-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

const text = (files: Map<string, Buffer>, path: string) => files.get(path)?.toString('utf8');
const json = (files: Map<string, Buffer>, path: string) => JSON.parse(text(files, path) ?? 'null') as Record<string, unknown>;

const KIT = {
  pack: 'sand-papyrus',
  licence: 'LICENSE.md',
  slots: { btn: { file: 'btn@2x.webp', slice: '18 fill', width: '9px' }, panel: { file: 'panel.weave@2x.webp', size: '96px 96px' } },
  colors: { 'tab-ink': '#502704' },
};
const kitFolder = () => folder({
  'kit.json': JSON.stringify(KIT),
  'btn@2x.webp': Buffer.from('btn picture'),
  'panel.weave@2x.webp': Buffer.from('panel picture'),
  'LICENSE.md': 'No commercial use without the author\'s permission.\n',
  'NOTES.md': 'How the pictures were made.\n',
  'spare@2x.webp': Buffer.from('a picture no slot names'),
});
const FONTS = {
  faces: [
    { family: 'Sand Serif', file: 'sand-serif-latin-600.woff2', weight: 600, style: 'normal', unicodeRange: 'U+0000-00FF' },
    { family: 'Sand Sans', file: 'sand-sans-latin-400.woff2', weight: 400, style: 'normal' },
  ],
};
const fontFolder = () => folder({
  'fonts.json': JSON.stringify(FONTS),
  'sand-serif-latin-600.woff2': Buffer.from('wOF2 serif'),
  'sand-sans-latin-400.woff2': Buffer.from('wOF2 sans'),
  'sand-serif-OFL.txt': 'SIL Open Font License 1.1\n',
  'sand-sans-OFL.txt': 'SIL Open Font License 1.1\n',
  'sand-serif.css': '@font-face { }',
});

describe('the archive of a built-in theme with a kit', () => {
  it('carries the kit as ui/kit.json and the pictures it names, under the kit\'s own licence', () => {
    const files = themeArchiveFiles('egypt', { kit: kitFolder() });
    expect(json(files, 'ui/kit.json')).toEqual(KIT);
    expect(text(files, 'ui/kit/btn@2x.webp')).toBe('btn picture');
    expect(text(files, 'ui/kit/panel.weave@2x.webp')).toBe('panel picture');
    expect([...files.keys()].filter(path => path.startsWith('ui/kit/')).sort()).toEqual(['ui/kit/btn@2x.webp', 'ui/kit/panel.weave@2x.webp']);
    expect(text(files, 'LICENSE')).toBe('No commercial use without the author\'s permission.\n');
    expect(json(files, 'theme.json')).toMatchObject({ id: 'egypt', license: 'see LICENSE' });
  });

  it('carries the fonts as ui/fonts.json, their files and their licences, and heads the look\'s stacks with them', () => {
    const files = themeArchiveFiles('egypt', { fonts: fontFolder(), displayFont: 'Sand Serif', bodyFont: 'Sand Sans' });
    expect(json(files, 'ui/fonts.json')).toEqual(FONTS);
    expect(text(files, 'ui/fonts/sand-serif-latin-600.woff2')).toBe('wOF2 serif');
    expect(text(files, 'ui/fonts/sand-sans-latin-400.woff2')).toBe('wOF2 sans');
    expect(text(files, 'ui/fonts/sand-serif-OFL.txt')).toContain('Open Font License');
    expect(files.has('ui/fonts/sand-serif.css')).toBe(false);
    const fonts = json(files, 'ui/look.json').fonts as Record<string, string[]>;
    expect(fonts.display![0]).toBe('Sand Serif');
    expect(fonts.body![0]).toBe('Sand Sans');
    expect(fonts.display!.at(-1)).toMatch(/^(serif|sans-serif|system-ui)$/);
  });

  it('packs a second theme of the same look under its own id and names', () => {
    const files = themeArchiveFiles('egypt', { kit: kitFolder(), id: 'egypt-gold', names: { en: 'Ancient Egypt, gold frames', ru: 'Древний Египет, золотые рамы' } });
    expect(json(files, 'theme.json')).toMatchObject({ id: 'egypt-gold', name: { en: 'Ancient Egypt, gold frames', ru: 'Древний Египет, золотые рамы' } });
  });

  it('refuses a stack font the fonts do not bring, and a kit picture that is missing', () => {
    expect(() => themeArchiveFiles('egypt', { fonts: fontFolder(), displayFont: 'Other Serif' })).toThrow(/Other Serif/);
    const broken = kitFolder();
    writeFileSync(join(broken, 'kit.json'), JSON.stringify({ ...KIT, slots: { ...KIT.slots, tab: { file: 'tab@2x.webp', slice: '12 fill', width: '6px' } } }));
    expect(() => themeArchiveFiles('egypt', { kit: broken })).toThrow(/tab@2x\.webp/);
  });
});
