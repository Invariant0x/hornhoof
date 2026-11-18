import { COMPANY_TEMPLATES, DEPARTMENT_TEMPLATES, type CompanyTemplate, type CompanyTemplateDept, type CompanyTemplateKey } from '@hornhoof/protocol/catalog';
import type { CSSProperties, ReactNode } from 'react';
import { useT, type Messages } from '../i18n';

export type Pick = CompanyTemplateKey | 'empty';

/* Everyone the company comes with: each department's staff and the members of its turnkey teams. */
const headcount = (t: CompanyTemplate) =>
  t.departments.reduce((n, d) => n + d.staff.reduce((s, line) => s + line.count, 0) + (DEPARTMENT_TEMPLATES.find(x => x.key === d.template)?.teamMembers ?? 0), 0);
const deptName = (t: Messages, dept: CompanyTemplateDept) => dept.name ?? t.templates[dept.template].name;

/* One box width everywhere, and departments wrap after four instead of shrinking, so a big company reads at the same
   scale as a small one. A box grows down by the lines its name takes, and the canvas by its rows; every card draws its
   scheme as high as the highest of them, so the cards of a row line up. */
const W = 280;
const PER_ROW = 4;
const BOX_W = 58;
const BOX_H = 26;
const BOX_GAP = 8;
const PROD_W = 22;
const PROD_H = 10;
const PROD_GAP = 6;
const ROOT_Y = 6;
const ROW_TOP = 28;
const ROW_GAP = 12;
const PROD_V = 6;
const BUS = 7;
/* The height a scheme never goes below, and the room left under its last row. */
const MIN_H = 114;
const BOTTOM = 6;
/* Characters that fit one line of a box at the text size, and the step from one line to the next. */
export const LINE_MAX = 11;
const LINE_H = 9;
const BOX_PAD = 8;

function rows<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += PER_ROW) out.push(items.slice(i, i + PER_ROW));
  return out;
}

/* A word longer than a whole line, in pieces that each fit one, every piece but the last ending in a hyphen. */
function pieces(word: string): string[] {
  const out: string[] = [];
  let rest = word;
  while (rest.length > LINE_MAX) {
    out.push(`${rest.slice(0, LINE_MAX - 1)}-`);
    rest = rest.slice(LINE_MAX - 1);
  }
  return [...out, rest];
}

/* A department name in as many lines as it needs: words go whole onto a line while they fit, and only a word longer than
   a whole line breaks. Nothing is cut and nothing is left out. */
export function nameLines(name: string): string[] {
  const lines: string[] = [];
  let line = '';
  for (const part of name.split(' ').filter(Boolean).flatMap(pieces)) {
    if (line && `${line} ${part}`.length <= LINE_MAX) line = `${line} ${part}`;
    else {
      if (line) lines.push(line);
      line = part;
    }
  }
  return line ? [...lines, line] : lines;
}

const boxHeight = (lines: number) => Math.max(BOX_H, lines * LINE_H + BOX_PAD);

type Placed = { x: number; y: number; h: number; name: string; lines: string[]; products: string[] };
type Layout = { rows: { busY: number; boxes: Placed[] }[]; height: number };

/* Where each department box goes: rows of four, each row as high as its tallest box, products under their box. */
export function schemeLayout(departments: readonly { name: string; products?: readonly string[] }[]): Layout {
  const placed: Layout['rows'] = [];
  let y = ROW_TOP;
  let bottom = 0;
  for (const row of rows(departments)) {
    const named = row.map(dept => ({ ...dept, lines: nameLines(dept.name) }));
    const h = Math.max(...named.map(dept => boxHeight(dept.lines.length)));
    const rowW = row.length * BOX_W + (row.length - 1) * BOX_GAP;
    const startX = (W - rowW) / 2;
    const withProducts = row.some(dept => dept.products?.length);
    placed.push({ busY: y - BUS, boxes: named.map((dept, i) => ({ x: startX + i * (BOX_W + BOX_GAP), y, h, name: dept.name, lines: dept.lines, products: [...(dept.products ?? [])] })) });
    bottom = y + h + (withProducts ? PROD_V + PROD_H : 0);
    y = bottom + ROW_GAP;
  }
  return { rows: placed, height: Math.max(MIN_H, bottom + BOTTOM) };
}

const namedDepartments = (t: Messages, template: CompanyTemplate) => template.departments.map(dept => ({ name: deptName(t, dept), products: dept.products }));

/* The department scheme the way the map looks: a company node at the top, a box per department wrapped into rows joined
   by a trunk and a bus per row, and a smaller box for each of a department's products under it. Lines are drawn first so
   they sit behind the boxes. Empty for "Start empty", so the cards still line up. */
export function Scheme({ template, t, height }: { template?: CompanyTemplate; t: Messages; height: number }) {
  const rootX = W / 2;
  const lines: ReactNode[] = [];
  const nodes: ReactNode[] = [<circle key="root" cx={rootX} cy={ROOT_Y} r={4} className="scheme-root" />];
  let trunkFrom = ROOT_Y + 4;
  for (const [ri, row] of schemeLayout(template ? namedDepartments(t, template) : []).rows.entries()) {
    const centers = row.boxes.map(box => box.x + BOX_W / 2);
    /* The trunk down the center, then a bus along this row, then a stub up to each box. */
    lines.push(<line key={`tr${ri}`} x1={rootX} y1={trunkFrom} x2={rootX} y2={row.busY} className="scheme-line" />);
    if (centers.length > 1) lines.push(<line key={`bus${ri}`} x1={Math.min(...centers, rootX)} y1={row.busY} x2={Math.max(...centers, rootX)} y2={row.busY} className="scheme-line" />);
    row.boxes.forEach((box, i) => {
      const cx = centers[i]!;
      const firstY = box.y + box.h / 2 - ((box.lines.length - 1) * LINE_H) / 2;
      lines.push(<line key={`st${ri}-${i}`} x1={cx} y1={row.busY} x2={cx} y2={box.y} className="scheme-line" />);
      nodes.push(
        <rect key={`r${ri}-${i}`} x={box.x} y={box.y} width={BOX_W} height={box.h} rx={4} className="scheme-dept" />,
        <text key={`t${ri}-${i}`} x={cx} y={firstY} className="scheme-name">
          {box.lines.map((line, k) => (
            <tspan key={k} x={cx} dy={k === 0 ? 0 : LINE_H} textLength={line.length > 9 ? BOX_W - 8 : undefined} lengthAdjust="spacingAndGlyphs">
              {line}
            </tspan>
          ))}
          <title>{box.name}</title>
        </text>,
      );
      if (box.products.length) {
        const pw = box.products.length * PROD_W + (box.products.length - 1) * PROD_GAP;
        const pStart = cx - pw / 2;
        const pTop = box.y + box.h + PROD_V;
        box.products.forEach((product, j) => {
          const px = pStart + j * (PROD_W + PROD_GAP);
          lines.push(<line key={`pl${ri}-${i}-${j}`} x1={cx} y1={box.y + box.h} x2={px + PROD_W / 2} y2={pTop} className="scheme-line" />);
          nodes.push(
            <rect key={`pr${ri}-${i}-${j}`} x={px} y={pTop} width={PROD_W} height={PROD_H} rx={3} className="scheme-prod">
              <title>{product}</title>
            </rect>,
          );
        });
      }
    });
    trunkFrom = row.busY;
  }
  return (
    <svg className="scheme" viewBox={`0 0 ${W} ${height}`} style={{ '--scheme-h': height } as CSSProperties} aria-hidden="true" preserveAspectRatio="xMidYMin meet">
      {lines}
      {nodes}
    </svg>
  );
}

/* The company templates on the first screen: a card each, with a mini department scheme, and "Start empty" first. */
export function CompanyTemplates({ value, onPick }: { value: Pick; onPick: (value: Pick) => void }) {
  const t = useT();
  const text = t.companyTemplates;
  /* Every scheme as high as the highest one in this language. */
  const height = Math.max(...COMPANY_TEMPLATES.map(template => schemeLayout(namedDepartments(t, template)).height));
  return (
    <fieldset className="templates-pick">
      <legend>{text.heading}</legend>
      <p className="muted">{text.hint}</p>
      <div className="template-cards">
        <label className={`template-card${value === 'empty' ? ' on' : ''}`}>
          <input type="radio" name="company-template" checked={value === 'empty'} onChange={() => onPick('empty')} />
          <Scheme t={t} height={height} />
          <span className="template-body">
            <b>{text.empty.name}</b>
            <small>{text.empty.description}</small>
          </span>
        </label>
        {COMPANY_TEMPLATES.map(template => (
          <label key={template.key} className={`template-card${value === template.key ? ' on' : ''}`}>
            <input type="radio" name="company-template" checked={value === template.key} onChange={() => onPick(template.key)} />
            <Scheme template={template} t={t} height={height} />
            <span className="template-body">
              <b>{text[template.key].name}</b>
              <small>{text[template.key].description}</small>
              <small className="template-depts">{text.departments(template.departments.map(d => deptName(t, d)).join(', '))}</small>
              <span className="template-count">{text.employees(headcount(template))}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
