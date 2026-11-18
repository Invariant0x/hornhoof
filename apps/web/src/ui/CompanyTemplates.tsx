import { COMPANY_TEMPLATES, DEPARTMENT_TEMPLATES, type CompanyTemplate, type CompanyTemplateDept, type CompanyTemplateKey } from '@hornhoof/protocol/catalog';
import type { ReactNode } from 'react';
import { useT, type Messages } from '../i18n';

export type Pick = CompanyTemplateKey | 'empty';

/* Everyone the company comes with: each department's staff and the members of its turnkey teams. */
const headcount = (t: CompanyTemplate) =>
  t.departments.reduce((n, d) => n + d.staff.reduce((s, line) => s + line.count, 0) + (DEPARTMENT_TEMPLATES.find(x => x.key === d.template)?.teamMembers ?? 0), 0);
const deptName = (t: Messages, dept: CompanyTemplateDept) => dept.name ?? t.templates[dept.template].name;

/* One box size everywhere, and departments wrap after four instead of shrinking, so a big company reads at the same
   scale as a small one. The viewBox is the same on every card, so the browser draws them all alike. */
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
const CANVAS_H = 114;
/* Characters that fit one line of a box at the text size; a longer name wraps to a second line. */
const LINE_MAX = 11;

function rows<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += PER_ROW) out.push(items.slice(i, i + PER_ROW));
  return out;
}

/* A department name on one line when it fits, else wrapped onto two at a space, so a name is never cut when the box has
   room. Only a single word longer than a box gets an ellipsis. */
function nameLines(name: string): string[] {
  const clip = (s: string) => (s.length > LINE_MAX + 1 ? `${s.slice(0, LINE_MAX)}…` : s);
  const words = name.split(' ');
  if (words.length === 1 || name.length <= LINE_MAX) return [clip(name)];
  let first = words[0]!;
  let i = 1;
  while (i < words.length && `${first} ${words[i]}`.length <= LINE_MAX) first += ` ${words[i++]}`;
  const second = words.slice(i).join(' ');
  return second ? [clip(first), clip(second)] : [clip(first)];
}

/* The department scheme the way the map looks: a company node at the top, a box per department wrapped into rows joined
   by a trunk and a bus per row, and a smaller box for each of a department's products under it. Lines are drawn first so
   they sit behind the boxes. Empty for "Start empty", so the cards still line up. */
function Scheme({ template, t }: { template?: CompanyTemplate; t: Messages }) {
  const rootX = W / 2;
  const lines: ReactNode[] = [];
  const nodes: ReactNode[] = [<circle key="root" cx={rootX} cy={ROOT_Y} r={4} className="scheme-root" />];
  let y = ROW_TOP;
  let trunkFrom = ROOT_Y + 4;
  for (const [ri, row] of rows(template?.departments ?? []).entries()) {
    const rowW = row.length * BOX_W + (row.length - 1) * BOX_GAP;
    const startX = (W - rowW) / 2;
    const busY = y - BUS;
    const centers = row.map((_, i) => startX + i * (BOX_W + BOX_GAP) + BOX_W / 2);
    /* The trunk down the center, then a bus along this row, then a stub up to each box. */
    lines.push(<line key={`tr${ri}`} x1={rootX} y1={trunkFrom} x2={rootX} y2={busY} className="scheme-line" />);
    if (centers.length > 1) lines.push(<line key={`bus${ri}`} x1={Math.min(...centers, rootX)} y1={busY} x2={Math.max(...centers, rootX)} y2={busY} className="scheme-line" />);
    let rowHasProducts = false;
    row.forEach((dept, i) => {
      const x = startX + i * (BOX_W + BOX_GAP);
      const cx = centers[i]!;
      const name = deptName(t, dept);
      const ls = nameLines(name);
      lines.push(<line key={`st${ri}-${i}`} x1={cx} y1={busY} x2={cx} y2={y} className="scheme-line" />);
      nodes.push(
        <rect key={`r${ri}-${i}`} x={x} y={y} width={BOX_W} height={BOX_H} rx={4} className="scheme-dept" />,
        <text key={`t${ri}-${i}`} x={cx} y={ls.length > 1 ? y + 9 : y + BOX_H / 2} className="scheme-name">
          {ls.map((line, k) => (
            <tspan key={k} x={cx} dy={k === 0 ? 0 : 9} textLength={line.length > 9 ? BOX_W - 8 : undefined} lengthAdjust="spacingAndGlyphs">
              {line}
            </tspan>
          ))}
          <title>{name}</title>
        </text>,
      );
      const products = dept.products ?? [];
      if (products.length) {
        rowHasProducts = true;
        const pw = products.length * PROD_W + (products.length - 1) * PROD_GAP;
        const pStart = cx - pw / 2;
        const pTop = y + BOX_H + PROD_V;
        products.forEach((product, j) => {
          const px = pStart + j * (PROD_W + PROD_GAP);
          lines.push(<line key={`pl${ri}-${i}-${j}`} x1={cx} y1={y + BOX_H} x2={px + PROD_W / 2} y2={pTop} className="scheme-line" />);
          nodes.push(
            <rect key={`pr${ri}-${i}-${j}`} x={px} y={pTop} width={PROD_W} height={PROD_H} rx={3} className="scheme-prod">
              <title>{product}</title>
            </rect>,
          );
        });
      }
    });
    trunkFrom = busY;
    y += BOX_H + (rowHasProducts ? PROD_V + PROD_H : 0) + ROW_GAP;
  }
  return (
    <svg className="scheme" viewBox={`0 0 ${W} ${CANVAS_H}`} aria-hidden="true" preserveAspectRatio="xMidYMin meet">
      {lines}
      {nodes}
    </svg>
  );
}

/* The company templates on the first screen: a card each, with a mini department scheme, and "Start empty" first. */
export function CompanyTemplates({ value, onPick }: { value: Pick; onPick: (value: Pick) => void }) {
  const t = useT();
  const text = t.companyTemplates;
  return (
    <fieldset className="templates-pick">
      <legend>{text.heading}</legend>
      <p className="muted">{text.hint}</p>
      <div className="template-cards">
        <label className={`template-card${value === 'empty' ? ' on' : ''}`}>
          <input type="radio" name="company-template" checked={value === 'empty'} onChange={() => onPick('empty')} />
          <Scheme t={t} />
          <span className="template-body">
            <b>{text.empty.name}</b>
            <small>{text.empty.description}</small>
          </span>
        </label>
        {COMPANY_TEMPLATES.map(template => (
          <label key={template.key} className={`template-card${value === template.key ? ' on' : ''}`}>
            <input type="radio" name="company-template" checked={value === template.key} onChange={() => onPick(template.key)} />
            <Scheme template={template} t={t} />
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
