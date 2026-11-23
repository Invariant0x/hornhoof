import { THEME_FILE_LIMITS, type ThemeProblemCode } from '@hornhoof/protocol/themes';
import { ArchiveRefused } from './zip.js';

/* An SVG picture of a theme's kit (docs/theme-archive.md, 3.3), taken only as a drawing: the elements and attributes
   of shapes, gradients, clips, masks and filters, with every reference inside the picture itself. No script, event,
   style sheet, animation, foreign object, embedded picture or link out passes; nor does a document type, an entity of
   its own or a processing instruction other than the XML declaration. What is not named here is refused. */

function refuse(code: ThemeProblemCode, path: string, detail: string): never {
  throw new ArchiveRefused({ code, path, detail: detail.slice(0, THEME_FILE_LIMITS.shown) });
}

const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'symbol', 'use',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan',
  'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB',
  'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset',
]);

const ATTRIBUTES = new Set([
  'id', 'class', 'version', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr',
  'd', 'points', 'pathLength', 'viewBox', 'preserveAspectRatio', 'transform', 'href', 'xlink:href',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'color', 'display', 'visibility', 'overflow',
  'clip-path', 'clip-rule', 'clipPathUnits', 'mask', 'maskUnits', 'maskContentUnits', 'filter', 'filterUnits', 'primitiveUnits',
  'gradientUnits', 'gradientTransform', 'spreadMethod', 'offset', 'stop-color', 'stop-opacity',
  'patternUnits', 'patternContentUnits', 'patternTransform', 'shape-rendering', 'color-interpolation-filters', 'vector-effect',
  'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing', 'dx', 'dy', 'rotate',
  'in', 'in2', 'result', 'mode', 'type', 'values', 'operator', 'k1', 'k2', 'k3', 'k4', 'stdDeviation', 'edgeMode', 'radius',
  'flood-color', 'flood-opacity', 'tableValues', 'slope', 'intercept', 'amplitude', 'exponent', 'xml:space',
]);

/* The namespaces an SVG file names, each only as itself. */
const NAMESPACES: Readonly<Record<string, string>> = { xmlns: 'http://www.w3.org/2000/svg', 'xmlns:xlink': 'http://www.w3.org/1999/xlink' };

const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const ENTITY = /&(?:#(\d{1,7})|#x([0-9A-Fa-f]{1,6})|(amp|lt|gt|quot|apos));|&/g;
const NAMED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/* A reference a value may hold: to an element of the picture, by its id. */
const LOCAL = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/;
const URL_OF = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
const SPACE = /\s/;

/* A value as the browser reads it, with its character references in place; an & that starts none refuses it. */
function decoded(path: string, raw: string): string {
  return raw.replace(ENTITY, (whole, decimal?: string, hex?: string, named?: string) => {
    if (whole === '&') refuse('svg_unsafe', path, 'an & that starts no character reference');
    if (named) return NAMED[named]!;
    const code = decimal ? Number(decimal) : parseInt(hex!, 16);
    if (code > 0x10ffff || code === 0) refuse('svg_unsafe', path, whole);
    return String.fromCodePoint(code);
  });
}

function checkAttribute(path: string, element: string, name: string, raw: string): void {
  const value = decoded(path, raw);
  if (name in NAMESPACES) {
    if (value !== NAMESPACES[name]) refuse('link_outside', path, `${name}="${value}"`);
    return;
  }
  const local = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
  if (/^on/i.test(local)) refuse('svg_unsafe', path, `${element} ${name}`);
  if (!ATTRIBUTES.has(name)) refuse('svg_unsafe', path, `${element} ${name}`);
  if ((name === 'href' || name === 'xlink:href') && !LOCAL.test(value.trim())) refuse('link_outside', path, `${element} ${name}="${value}"`);
  for (const [, , target] of value.matchAll(URL_OF)) if (!LOCAL.test(target!.trim())) refuse('link_outside', path, `${element} ${name}="${value}"`);
  const rest = value.replace(URL_OF, '');
  if (/[a-z][a-z0-9+.-]*:\/\/|^\s*\/\//i.test(rest)) refuse('link_outside', path, `${element} ${name}="${value}"`);
  if (/url\s*\(|[\\<>]|javascript\s*:|@import|expression\s*\(/i.test(rest)) refuse('svg_unsafe', path, `${element} ${name}="${value}"`);
}

/* The attributes of a tag, from after its name to its end. */
function checkAttributes(path: string, element: string, text: string): void {
  let at = 0;
  const seen = new Set<string>();
  while (at < text.length) {
    while (at < text.length && SPACE.test(text[at]!)) at += 1;
    if (at >= text.length) break;
    const eq = text.indexOf('=', at);
    if (eq < 0) refuse('svg_unsafe', path, `${element}: an attribute with no value`);
    const name = text.slice(at, eq).trim();
    if (!NAME.test(name) || seen.has(name)) refuse('svg_unsafe', path, `${element} ${name}`);
    seen.add(name);
    let open = eq + 1;
    while (open < text.length && SPACE.test(text[open]!)) open += 1;
    const quote = text[open];
    if (quote !== '"' && quote !== "'") refuse('svg_unsafe', path, `${element} ${name}: a value with no quotes`);
    const close = text.indexOf(quote, open + 1);
    if (close < 0) refuse('svg_unsafe', path, `${element} ${name}: a value with no end`);
    checkAttribute(path, element, name, text.slice(open + 1, close));
    at = close + 1;
    if (at < text.length && !SPACE.test(text[at]!)) refuse('svg_unsafe', path, `${element}: attributes run together`);
  }
}

/* Checks an SVG of the kit, whose bytes are plain UTF-8 text already: throws why it is refused. */
export function checkSvg(path: string, text: string): void {
  let at = 0;
  const open: string[] = [];
  let roots = 0;
  const declaration = /^\s*<\?xml\s[^?<>]*\?>/.exec(text);
  if (declaration) at = declaration[0].length;
  while (at < text.length) {
    const lt = text.indexOf('<', at);
    const words = text.slice(at, lt < 0 ? text.length : lt);
    if (words.includes('>')) refuse('svg_unsafe', path, 'a > outside a tag');
    if (words.trim() && !open.length) refuse('svg_unsafe', path, 'text outside the picture');
    decoded(path, words);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0 || text.slice(lt + 4, end).includes('--')) refuse('svg_unsafe', path, 'a comment with no end');
      at = end + 3;
      continue;
    }
    if (text.startsWith('<!', lt) || text.startsWith('<?', lt)) refuse('svg_unsafe', path, text.slice(lt, lt + 12));
    const gt = text.indexOf('>', lt);
    if (gt < 0) refuse('svg_unsafe', path, 'a tag with no end');
    const tag = text.slice(lt + 1, gt);
    if (tag.includes('<')) refuse('svg_unsafe', path, 'a < inside a tag');
    at = gt + 1;
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      if (open.pop() !== name) refuse('svg_unsafe', path, `</${name}> closes no open element`);
      continue;
    }
    const empty = tag.endsWith('/');
    const body = empty ? tag.slice(0, -1) : tag;
    const name = /^[^\s]*/.exec(body)![0];
    if (!ELEMENTS.has(name)) refuse('svg_unsafe', path, `<${name}>`);
    if (!open.length) {
      roots += 1;
      if (name !== 'svg' || roots > 1) refuse('svg_unsafe', path, 'a picture is one <svg> element');
    }
    checkAttributes(path, name, body.slice(name.length));
    if (!empty) open.push(name);
  }
  if (open.length || roots !== 1) refuse('svg_unsafe', path, open.length ? `<${open.at(-1)}> is never closed` : 'no <svg> element');
}
