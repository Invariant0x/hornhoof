export type GeometryMeasurement = {
  sourceSha: string; harnessSha: string; dataSha256: string; fontsSha256: string;
  caseId: string; engine: string; status: 'measured'; screenshotSha256: string; dpr: number;
  dimensions: Record<string, number>; icons: { id: string; dx: number; dy: number }[];
  clipping: unknown[]; horizontalOverflow: unknown[];
};

type Rectangle = { x: number; y: number; width: number; height: number };

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(name + ' must be an object');
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(name + ' must be a nonempty string');
  return value;
}

function hash(value: unknown, length: number, name: string): string {
  const result = text(value, name);
  if (!new RegExp('^[a-f0-9]{' + length + '}$').test(result)) throw new Error(name + ' has an invalid hash');
  return result;
}

function number(value: unknown, name: string, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(name + ' must be finite');
  if (positive && value <= 0) throw new Error(name + ' must be positive');
  return value;
}

function rectangle(value: unknown, name: string): Rectangle {
  const label = name + ' rectangle', row = object(value, label);
  return { x: number(row.x, label + '.x'), y: number(row.y, label + '.y'),
    width: number(row.width, label + '.width', true), height: number(row.height, label + '.height', true) };
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(name + ' must be an array');
  return value;
}

function icon(value: unknown) {
  const row = object(value, 'geometry icon'), id = text(row.id, 'geometry icon identity');
  const button = rectangle(row.button, 'geometry icon button'), svg = rectangle(row.svg, 'geometry icon SVG');
  return { id, button, dx: svg.x + svg.width / 2 - (button.x + button.width / 2),
    dy: svg.y + svg.height / 2 - (button.y + button.height / 2) };
}

function measuredEngine(row: Record<string, unknown>): string {
  if (row.status !== 'measured') throw new Error('Only measured capture status can be normalized');
  if (typeof row.engine !== 'string' || !['chromium', 'firefox', 'webkit'].includes(row.engine)) throw new Error('Invalid capture engine');
  return row.engine;
}

function overflow(geometry: Record<string, unknown>): unknown[] {
  const elements = array(geometry.horizontalOverflow, 'geometry horizontalOverflow');
  if (typeof geometry.pageHorizontalOverflow !== 'boolean') throw new Error('geometry pageHorizontalOverflow must be a boolean');
  return geometry.pageHorizontalOverflow ? [...elements, { selector: 'html', reason: 'viewport-overflow' }] : [...elements];
}

/* Normalize evidence only. Browser execution and runtime/export receipts are checked separately. */
export function geometryMeasurement(record: unknown): GeometryMeasurement {
  const row = object(record, 'Capture'), engine = measuredEngine(row), geometry = object(row.geometry, 'geometry');
  const panel = rectangle(geometry.panel, 'geometry panel'), body = rectangle(geometry.body, 'geometry body');
  const viewport = object(geometry.viewport, 'geometry viewport');
  const icons = array(geometry.icons, 'geometry icons').map(icon);
  const dimensions: Record<string, number> = { 'panel.width': panel.width, 'panel.height': panel.height,
    'body.width': body.width, 'body.height': body.height };
  for (const item of icons) {
    dimensions[item.id + '.width'] = item.button.width; dimensions[item.id + '.height'] = item.button.height;
  }
  return {
    sourceSha: hash(row.sourceSha, 40, 'Source identity'), harnessSha: hash(row.harnessSha, 40, 'Harness identity'),
    dataSha256: hash(row.dataSha256, 64, 'Data identity'), fontsSha256: hash(row.fontsSha256, 64, 'Fonts identity'),
    caseId: text(row.caseId, 'Case identity'), engine, status: 'measured', screenshotSha256: hash(row.screenshotSha256, 64, 'Screenshot identity'),
    dpr: number(viewport.dpr, 'geometry viewport dpr', true), dimensions,
    icons: icons.map(({ id, dx, dy }) => ({ id, dx, dy })),
    clipping: [...array(geometry.clips, 'geometry clips')], horizontalOverflow: overflow(geometry),
  };
}
