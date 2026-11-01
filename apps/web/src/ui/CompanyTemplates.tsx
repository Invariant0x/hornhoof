import { useT } from '../i18n';
import { COMPANY_TEMPLATES, TEMPLATES, type CompanyTemplate, type CompanyTemplateKey } from '../templates';

export type Pick = CompanyTemplateKey | 'empty';

const roleCode = (template: string) => TEMPLATES.find(x => x.key === template)?.roleCode ?? '';
const headcount = (t: CompanyTemplate) => t.departments.reduce((n, d) => n + d.staff.reduce((s, line) => s + line.count, 0), 0);

const BOX_W = 46;
const BOX_H = 20;
const GAP = 10;
const PROD_W = 30;
const PROD_H = 13;
const PROD_GAP = 6;
const TOP = 26;
const PROD_TOP = TOP + BOX_H + 14;

/* A small department scheme drawn the way the map looks: a company node at the top, a box per department under it, and
   a smaller box for each of a department's products. It scales to the card width through its viewBox. */
function Scheme({ template, label }: { template: CompanyTemplate; label: string }) {
  const depts = template.departments;
  const width = Math.max(depts.length * BOX_W + (depts.length - 1) * GAP, BOX_W);
  const hasProducts = depts.some(d => (d.products?.length ?? 0) > 0);
  const height = (hasProducts ? PROD_TOP + PROD_H : TOP + BOX_H) + 4;
  const rootX = width / 2;

  return (
    <svg className="scheme" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} preserveAspectRatio="xMidYMid meet">
      <circle cx={rootX} cy={6} r={4} className="scheme-root" />
      {depts.map((dept, i) => {
        const x = i * (BOX_W + GAP);
        const cx = x + BOX_W / 2;
        const products = dept.products ?? [];
        const prodWidth = products.length * PROD_W + (products.length - 1) * PROD_GAP;
        const prodStart = cx - prodWidth / 2;
        return (
          <g key={dept.name ?? dept.template}>
            <line x1={rootX} y1={10} x2={cx} y2={TOP} className="scheme-line" />
            <rect x={x} y={TOP} width={BOX_W} height={BOX_H} rx={4} className="scheme-dept" />
            <text x={cx} y={TOP + BOX_H / 2} className="scheme-code">{roleCode(dept.template)}</text>
            {products.map((product, j) => {
              const px = prodStart + j * (PROD_W + PROD_GAP);
              return (
                <g key={product}>
                  <line x1={cx} y1={TOP + BOX_H} x2={px + PROD_W / 2} y2={PROD_TOP} className="scheme-line" />
                  <rect x={px} y={PROD_TOP} width={PROD_W} height={PROD_H} rx={3} className="scheme-prod" />
                </g>
              );
            })}
          </g>
        );
      })}
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
        <label className={`template-card empty${value === 'empty' ? ' on' : ''}`}>
          <input type="radio" name="company-template" checked={value === 'empty'} onChange={() => onPick('empty')} />
          <span className="template-body">
            <b>{text.empty.name}</b>
            <small>{text.empty.description}</small>
          </span>
        </label>
        {COMPANY_TEMPLATES.map(template => (
          <label key={template.key} className={`template-card${value === template.key ? ' on' : ''}`}>
            <input type="radio" name="company-template" checked={value === template.key} onChange={() => onPick(template.key)} />
            <Scheme template={template} label={text.scheme} />
            <span className="template-body">
              <b>{text[template.key].name}</b>
              <small>{text[template.key].description}</small>
              <span className="template-people">{text.people(headcount(template))}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
