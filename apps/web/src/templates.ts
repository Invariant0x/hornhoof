import type { TemplateKey } from './types';

/* The department templates in card order, as the server has them; kept here so the browser does not load the protocol's validators. */
export const TEMPLATES: readonly { key: TemplateKey; roleCode: string; ticked: boolean; always: boolean; teamMembers: number }[] = [
  { key: 'operations', roleCode: 'OPS', ticked: true, always: true, teamMembers: 1 },
  { key: 'development', roleCode: 'DEV', ticked: true, always: false, teamMembers: 2 },
  { key: 'marketing', roleCode: 'MKT', ticked: true, always: false, teamMembers: 1 },
  { key: 'sales', roleCode: 'SAL', ticked: true, always: false, teamMembers: 1 },
  { key: 'business_development', roleCode: 'BIZ', ticked: true, always: false, teamMembers: 1 },
  { key: 'design', roleCode: 'DSN', ticked: false, always: false, teamMembers: 1 },
  { key: 'support', roleCode: 'SUP', ticked: false, always: false, teamMembers: 1 },
  { key: 'finance', roleCode: 'FIN', ticked: false, always: false, teamMembers: 1 },
  { key: 'home_devices', roleCode: 'HOM', ticked: false, always: false, teamMembers: 1 },
  { key: 'household', roleCode: 'HHD', ticked: false, always: false, teamMembers: 1 },
];

export type CompanyTemplateKey = 'project' | 'startup' | 'studio' | 'corporation' | 'security' | 'opensource' | 'agency' | 'lab' | 'home';
export type CompanyTemplateDept = { template: TemplateKey; name?: string; products?: string[]; staff: { role: string; count: number }[] };
export type CompanyTemplate = { key: CompanyTemplateKey; departments: readonly CompanyTemplateDept[] };

/* The ready-made companies on the first screen, the same as the server's COMPANY_TEMPLATES (a test keeps them equal). The
   card draws its mini scheme from the departments and their products, and shows the headcount from the staff counts and
   the members of each department's turnkey teams. */
export const COMPANY_TEMPLATES: readonly CompanyTemplate[] = [
  {
    key: 'project',
    departments: [{ template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-PM', count: 1 }] }, { template: 'development', staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ENG', count: 2 }, { role: 'DEV-REV', count: 1 }, { role: 'DEV-PM', count: 1 }] }],
  },
  {
    key: 'startup',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-PM', count: 1 }] },
      { template: 'development', staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ENG', count: 2 }, { role: 'DEV-REV', count: 1 }, { role: 'DEV-SEC', count: 1 }, { role: 'DEV-PM', count: 1 }] },
      { template: 'design', staff: [{ role: 'DSN-HEAD', count: 1 }, { role: 'DSN-UI', count: 1 }, { role: 'DSN-PM', count: 1 }] },
      { template: 'marketing', staff: [{ role: 'MKT-HEAD', count: 1 }, { role: 'MKT-WRITE', count: 1 }, { role: 'MKT-PM', count: 1 }] },
      { template: 'business_development', staff: [{ role: 'BIZ-HEAD', count: 1 }, { role: 'BIZ-ANALYST', count: 1 }, { role: 'BIZ-PM', count: 1 }] },
    ],
  },
  {
    key: 'studio',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-INTEG', count: 1 }, { role: 'OPS-PM', count: 1 }] },
      {
        template: 'development',
        products: ['Product 1', 'Product 2', 'Product 3'],
        staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ENG', count: 3 }, { role: 'DEV-REV', count: 2 }, { role: 'DEV-SEC', count: 1 }, { role: 'DEV-PM', count: 1 }],
      },
    ],
  },
  {
    key: 'corporation',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-INTEG', count: 1 }, { role: 'OPS-FIX', count: 1 }, { role: 'OPS-PM', count: 1 }] },
      {
        template: 'development',
        products: ['Product 1', 'Product 2'],
        staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ARCH', count: 1 }, { role: 'DEV-ENG', count: 3 }, { role: 'DEV-REV', count: 2 }, { role: 'DEV-SEC', count: 1 }, { role: 'DEV-PM', count: 1 }],
      },
      { template: 'design', staff: [{ role: 'DSN-HEAD', count: 1 }, { role: 'DSN-UI', count: 1 }, { role: 'DSN-SYS', count: 1 }, { role: 'DSN-PM', count: 1 }] },
      { template: 'marketing', staff: [{ role: 'MKT-HEAD', count: 1 }, { role: 'MKT-WRITE', count: 1 }, { role: 'MKT-SEO', count: 1 }, { role: 'MKT-PM', count: 1 }] },
      { template: 'sales', staff: [{ role: 'SAL-HEAD', count: 1 }, { role: 'SAL-AE', count: 1 }, { role: 'SAL-SDR', count: 1 }, { role: 'SAL-PM', count: 1 }] },
      { template: 'support', staff: [{ role: 'SUP-HEAD', count: 1 }, { role: 'SUP-T1', count: 1 }, { role: 'SUP-T2', count: 1 }, { role: 'SUP-PM', count: 1 }] },
      { template: 'finance', staff: [{ role: 'FIN-HEAD', count: 1 }, { role: 'FIN-BOOK', count: 1 }, { role: 'FIN-PM', count: 1 }] },
      { template: 'business_development', staff: [{ role: 'BIZ-HEAD', count: 1 }, { role: 'BIZ-PARTNER', count: 1 }, { role: 'BIZ-PM', count: 1 }] },
    ],
  },
  {
    key: 'security',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-INTEG', count: 1 }, { role: 'OPS-PM', count: 1 }] },
      { template: 'development', staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ENG', count: 2 }, { role: 'DEV-SEC', count: 1 }, { role: 'DEV-RED', count: 1 }, { role: 'DEV-PM', count: 1 }] },
      { template: 'sales', staff: [{ role: 'SAL-HEAD', count: 1 }, { role: 'SAL-AE', count: 1 }, { role: 'SAL-PM', count: 1 }] },
      { template: 'support', staff: [{ role: 'SUP-HEAD', count: 1 }, { role: 'SUP-T1', count: 1 }, { role: 'SUP-PM', count: 1 }] },
    ],
  },
  {
    key: 'opensource',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-PM', count: 1 }] },
      { template: 'development', staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ENG', count: 2 }, { role: 'DEV-REV', count: 1 }, { role: 'DEV-DOCS', count: 1 }, { role: 'DEV-PM', count: 1 }] },
      { template: 'support', staff: [{ role: 'SUP-HEAD', count: 1 }, { role: 'SUP-KB', count: 1 }, { role: 'SUP-PM', count: 1 }] },
    ],
  },
  {
    key: 'agency',
    departments: [
      { template: 'sales', staff: [{ role: 'SAL-HEAD', count: 1 }, { role: 'SAL-AE', count: 1 }, { role: 'SAL-SDR', count: 1 }, { role: 'SAL-PM', count: 1 }] },
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-INTEG', count: 1 }, { role: 'OPS-FIX', count: 1 }, { role: 'OPS-PM', count: 1 }] },
      { template: 'support', staff: [{ role: 'SUP-HEAD', count: 1 }, { role: 'SUP-T1', count: 1 }, { role: 'SUP-T2', count: 1 }, { role: 'SUP-PM', count: 1 }] },
    ],
  },
  {
    key: 'lab',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-PM', count: 1 }] },
      { template: 'development', staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ARCH', count: 1 }, { role: 'DEV-ENG', count: 2 }, { role: 'DEV-DOCS', count: 1 }, { role: 'DEV-PM', count: 1 }] },
      { template: 'business_development', staff: [{ role: 'BIZ-HEAD', count: 1 }, { role: 'BIZ-ANALYST', count: 1 }, { role: 'BIZ-PM', count: 1 }] },
    ],
  },
  {
    key: 'home',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-PM', count: 1 }] },
      { template: 'home_devices', staff: [{ role: 'HOM-HEAD', count: 1 }, { role: 'HOM-NET', count: 1 }, { role: 'HOM-SMART', count: 1 }, { role: 'HOM-PM', count: 1 }] },
      { template: 'household', staff: [{ role: 'HHD-HEAD', count: 1 }, { role: 'HHD-SUPPLY', count: 1 }, { role: 'HHD-BILLS', count: 1 }, { role: 'HHD-CAL', count: 1 }, { role: 'HHD-PM', count: 1 }] },
    ],
  },
];
