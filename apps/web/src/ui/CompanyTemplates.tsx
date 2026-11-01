import type { ReactNode } from 'react';
import { useT, type Messages } from '../i18n';
import { COMPANY_TEMPLATES, type CompanyTemplate, type CompanyTemplateDept, type CompanyTemplateKey } from '../templates';

export type Pick = CompanyTemplateKey | 'empty';

const headcount = (t: CompanyTemplate) => t.departments.reduce((n, d) => n + d.staff.reduce((s, line) => s + line.count, 0), 0);
const deptName = (t: Messages, dept: CompanyTemplateDept) => dept.name ?? t.templates[dept.template].name;
/* The box is small, so a long name is cut with an ellipsis; the whole name stays in the box title and the line below. */
const short = (name: string) => (name.length > 12 ? `${name.slice(0, 11)}…` : name);

/* One box size everywhere, and departments wrap after four instead of shrinking, so a big company reads at the same
   scale as a small one. The viewBox is the same on every card, so the browser draws them all alike. */
const W = 280;
const PER_ROW = 4;
const BOX_W = 58;
const BOX_H = 22;
const BOX_GAP = 8;
const PROD_W = 22;
const PROD_H = 10;
const PROD_GAP = 6;
const ROOT_Y = 6;
const ROW_TOP = 26;
const ROW_GAP = 10;
const PROD_V = 6;
const CANVAS_H = 104;

function rows<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += PER_ROW) out.push(items.slice(i, i + PER_ROW));
  return out;
}

/* The department scheme the way the map looks: a company node at the top, a box per department wrapped into rows, and a
   smaller box for each of a department's products under it. Empty for "Start empty", so the cards still line up. */
function Scheme({ template, label, t }: { template?: CompanyTemplate; label: string; t: Messages }) {
  const rootX = W / 2;
  const parts: ReactNode[] = [<circle key="root" cx={rootX} cy={ROOT_Y} r={4} className="scheme-root" />];
  let y = ROW_TOP;
  for (const [ri, row] of rows(template?.departments ?? []).entries()) {
    const rowW = row.length * BOX_W + (row.length - 1) * BOX_GAP;
    const startX = (W - rowW) / 2;
    let rowHasProducts = false;
    row.forEach((dept, i) => {
      const x = startX + i * (BOX_W + BOX_GAP);
      const cx = x + BOX_W / 2;
      const name = deptName(t, dept);
      const products = dept.products ?? [];
      parts.push(
        <line key={`l${ri}-${i}`} x1={rootX} y1={ROOT_Y + 4} x2={cx} y2={y} className="scheme-line" />,
        <rect key={`r${ri}-${i}`} x={x} y={y} width={BOX_W} height={BOX_H} rx={4} className="scheme-dept" />,
        <text key={`t${ri}-${i}`} x={cx} y={y + BOX_H / 2} className="scheme-name" textLength={short(name).length > 9 ? BOX_W - 8 : undefined} lengthAdjust="spacingAndGlyphs">{short(name)}<title>{name}</title></text>,
      );
      if (products.length) {
        rowHasProducts = true;
        const pw = products.length * PROD_W + (products.length - 1) * PROD_GAP;
        const pStart = cx - pw / 2;
        const pTop = y + BOX_H + PROD_V;
        products.forEach((product, j) => {
          const px = pStart + j * (PROD_W + PROD_GAP);
          parts.push(
            <line key={`pl${ri}-${i}-${j}`} x1={cx} y1={y + BOX_H} x2={px + PROD_W / 2} y2={pTop} className="scheme-line" />,
            <rect key={`pr${ri}-${i}-${j}`} x={px} y={pTop} width={PROD_W} height={PROD_H} rx={3} className="scheme-prod"><title>{product}</title></rect>,
          );
        });
      }
    });
    y += BOX_H + (rowHasProducts ? PROD_V + PROD_H : 0) + ROW_GAP;
  }
  return (
    <svg className="scheme" viewBox={`0 0 ${W} ${CANVAS_H}`} role="img" aria-label={label} preserveAspectRatio="xMidYMin meet">
      {parts}
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
          <Scheme label={text.scheme} t={t} />
          <span className="template-body">
            <b>{text.empty.name}</b>
            <small>{text.empty.description}</small>
          </span>
        </label>
        {COMPANY_TEMPLATES.map(template => (
          <label key={template.key} className={`template-card${value === template.key ? ' on' : ''}`}>
            <input type="radio" name="company-template" checked={value === template.key} onChange={() => onPick(template.key)} />
            <Scheme template={template} label={text.scheme} t={t} />
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
