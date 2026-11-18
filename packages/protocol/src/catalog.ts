/* The departments and the ready-made companies Hornhoof starts from: plain data with no validators, so the web app takes it
   from this subpath without loading zod, and the main entry hands the server the same lists. */

export const TEMPLATE_KEYS = ['operations', 'development', 'marketing', 'sales', 'business_development', 'design', 'support', 'finance', 'home_devices', 'household', 'video_production'] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

/* The departments the orchestrator starts from. Names and descriptions live in the web dictionaries and the server's prompt.
   teamMembers: how many people the turnkey teams of its template bring, for the headcount on a company template's card;
   a test keeps it equal to the team templates. */
export const DEPARTMENT_TEMPLATES: readonly { key: TemplateKey; roleCode: string; ticked: boolean; always: boolean; teamMembers: number }[] = [
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
  { key: 'video_production', roleCode: 'VID', ticked: false, always: false, teamMembers: 1 },
];

/* A ready-made company the CEO can pick on the first screen. Each one lists departments to create, with their products
   and the people setup hires into them (role code and how many). The names and descriptions live in the web dictionaries;
   the mini scheme on the card is drawn from these departments. "Start empty" is not here: it is the default on the card,
   and creates nothing. The people take a subscription the company has that may serve them, or wait for one. */
export const COMPANY_TEMPLATE_KEYS = ['project', 'startup', 'studio', 'corporation', 'security', 'opensource', 'agency', 'lab', 'video_studio', 'home'] as const;
export type CompanyTemplateKey = (typeof COMPANY_TEMPLATE_KEYS)[number];
export type CompanyTemplateStaff = { role: string; count: number };
export type CompanyTemplateDept = { template: TemplateKey; name?: string; products?: string[]; staff: CompanyTemplateStaff[] };
export type CompanyTemplate = { key: CompanyTemplateKey; departments: readonly CompanyTemplateDept[] };

export const COMPANY_TEMPLATES: readonly CompanyTemplate[] = [
  {
    key: 'project',
    departments: [{ template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-PM', count: 1 }, { role: 'OPS-FIX', count: 1 }, { role: 'OPS-INTEG', count: 1 }, { role: 'OPS-ACCT', count: 1 }] }, { template: 'development', staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ENG', count: 2 }, { role: 'DEV-REV', count: 1 }, { role: 'DEV-PM', count: 1 }, { role: 'DEV-ARCH', count: 1 }, { role: 'DEV-SEC', count: 1 }, { role: 'DEV-TEST', count: 1 }, { role: 'DEV-DOCS', count: 1 }, { role: 'DEV-OPS', count: 1 }] }],
  },
  {
    key: 'startup',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-PM', count: 1 }, { role: 'OPS-FIX', count: 1 }, { role: 'OPS-INTEG', count: 1 }, { role: 'OPS-ACCT', count: 1 }] },
      { template: 'development', products: ['Product 1'], staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ENG', count: 2 }, { role: 'DEV-REV', count: 1 }, { role: 'DEV-SEC', count: 1 }, { role: 'DEV-PM', count: 1 }, { role: 'DEV-ARCH', count: 1 }, { role: 'DEV-TEST', count: 1 }, { role: 'DEV-DOCS', count: 1 }, { role: 'DEV-OPS', count: 1 }] },
      { template: 'design', staff: [{ role: 'DSN-HEAD', count: 1 }, { role: 'DSN-UI', count: 1 }, { role: 'DSN-PM', count: 1 }, { role: 'DSN-QA', count: 1 }, { role: 'DSN-SYS', count: 1 }] },
      { template: 'marketing', staff: [{ role: 'MKT-HEAD', count: 1 }, { role: 'MKT-WRITE', count: 1 }, { role: 'MKT-PM', count: 1 }, { role: 'MKT-EDIT', count: 1 }, { role: 'MKT-SOCIAL', count: 1 }, { role: 'MKT-SEO', count: 1 }] },
      { template: 'business_development', staff: [{ role: 'BIZ-HEAD', count: 1 }, { role: 'BIZ-ANALYST', count: 1 }, { role: 'BIZ-PM', count: 1 }, { role: 'BIZ-REV', count: 1 }, { role: 'BIZ-PARTNER', count: 1 }] },
    ],
  },
  {
    key: 'studio',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-INTEG', count: 1 }, { role: 'OPS-PM', count: 1 }, { role: 'OPS-FIX', count: 1 }, { role: 'OPS-ACCT', count: 1 }] },
      {
        template: 'development',
        products: ['Product 1', 'Product 2', 'Product 3'],
        staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ENG', count: 3 }, { role: 'DEV-REV', count: 2 }, { role: 'DEV-SEC', count: 1 }, { role: 'DEV-PM', count: 1 }, { role: 'DEV-ARCH', count: 1 }, { role: 'DEV-TEST', count: 1 }, { role: 'DEV-DOCS', count: 1 }, { role: 'DEV-OPS', count: 1 }],
      },
    ],
  },
  {
    key: 'corporation',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-INTEG', count: 1 }, { role: 'OPS-FIX', count: 1 }, { role: 'OPS-PM', count: 1 }, { role: 'OPS-ACCT', count: 1 }] },
      {
        template: 'development',
        products: ['Product 1', 'Product 2'],
        staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ARCH', count: 1 }, { role: 'DEV-ENG', count: 3 }, { role: 'DEV-REV', count: 2 }, { role: 'DEV-SEC', count: 1 }, { role: 'DEV-PM', count: 1 }, { role: 'DEV-TEST', count: 1 }, { role: 'DEV-DOCS', count: 1 }, { role: 'DEV-OPS', count: 1 }],
      },
      { template: 'design', staff: [{ role: 'DSN-HEAD', count: 1 }, { role: 'DSN-UI', count: 1 }, { role: 'DSN-SYS', count: 1 }, { role: 'DSN-PM', count: 1 }, { role: 'DSN-QA', count: 1 }] },
      { template: 'marketing', staff: [{ role: 'MKT-HEAD', count: 1 }, { role: 'MKT-WRITE', count: 1 }, { role: 'MKT-SEO', count: 1 }, { role: 'MKT-PM', count: 1 }, { role: 'MKT-EDIT', count: 1 }, { role: 'MKT-SOCIAL', count: 1 }] },
      { template: 'sales', staff: [{ role: 'SAL-HEAD', count: 1 }, { role: 'SAL-AE', count: 1 }, { role: 'SAL-SDR', count: 1 }, { role: 'SAL-PM', count: 1 }, { role: 'SAL-REV', count: 1 }, { role: 'SAL-OPS', count: 1 }] },
      { template: 'support', staff: [{ role: 'SUP-HEAD', count: 1 }, { role: 'SUP-T1', count: 1 }, { role: 'SUP-T2', count: 1 }, { role: 'SUP-PM', count: 1 }, { role: 'SUP-QA', count: 1 }, { role: 'SUP-KB', count: 1 }] },
      { template: 'finance', staff: [{ role: 'FIN-HEAD', count: 1 }, { role: 'FIN-BOOK', count: 1 }, { role: 'FIN-PM', count: 1 }, { role: 'FIN-AUDIT', count: 1 }, { role: 'FIN-FPA', count: 1 }] },
      { template: 'business_development', staff: [{ role: 'BIZ-HEAD', count: 1 }, { role: 'BIZ-PARTNER', count: 1 }, { role: 'BIZ-PM', count: 1 }, { role: 'BIZ-ANALYST', count: 1 }, { role: 'BIZ-REV', count: 1 }] },
    ],
  },
  {
    key: 'security',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-INTEG', count: 1 }, { role: 'OPS-PM', count: 1 }, { role: 'OPS-FIX', count: 1 }, { role: 'OPS-ACCT', count: 1 }] },
      { template: 'development', staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ENG', count: 2 }, { role: 'DEV-SEC', count: 1 }, { role: 'DEV-RED', count: 1 }, { role: 'DEV-PM', count: 1 }, { role: 'DEV-ARCH', count: 1 }, { role: 'DEV-REV', count: 1 }, { role: 'DEV-TEST', count: 1 }, { role: 'DEV-DOCS', count: 1 }, { role: 'DEV-OPS', count: 1 }] },
      { template: 'sales', staff: [{ role: 'SAL-HEAD', count: 1 }, { role: 'SAL-AE', count: 1 }, { role: 'SAL-PM', count: 1 }, { role: 'SAL-SDR', count: 1 }, { role: 'SAL-REV', count: 1 }, { role: 'SAL-OPS', count: 1 }] },
      { template: 'support', staff: [{ role: 'SUP-HEAD', count: 1 }, { role: 'SUP-T1', count: 1 }, { role: 'SUP-PM', count: 1 }, { role: 'SUP-T2', count: 1 }, { role: 'SUP-QA', count: 1 }, { role: 'SUP-KB', count: 1 }] },
    ],
  },
  {
    key: 'opensource',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-PM', count: 1 }, { role: 'OPS-FIX', count: 1 }, { role: 'OPS-INTEG', count: 1 }, { role: 'OPS-ACCT', count: 1 }] },
      { template: 'development', staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ENG', count: 2 }, { role: 'DEV-REV', count: 1 }, { role: 'DEV-DOCS', count: 1 }, { role: 'DEV-PM', count: 1 }, { role: 'DEV-ARCH', count: 1 }, { role: 'DEV-SEC', count: 1 }, { role: 'DEV-TEST', count: 1 }, { role: 'DEV-OPS', count: 1 }] },
      { template: 'support', staff: [{ role: 'SUP-HEAD', count: 1 }, { role: 'SUP-KB', count: 1 }, { role: 'SUP-PM', count: 1 }, { role: 'SUP-T1', count: 1 }, { role: 'SUP-T2', count: 1 }, { role: 'SUP-QA', count: 1 }] },
    ],
  },
  {
    key: 'agency',
    departments: [
      { template: 'sales', staff: [{ role: 'SAL-HEAD', count: 1 }, { role: 'SAL-AE', count: 1 }, { role: 'SAL-SDR', count: 1 }, { role: 'SAL-PM', count: 1 }, { role: 'SAL-REV', count: 1 }, { role: 'SAL-OPS', count: 1 }] },
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-INTEG', count: 1 }, { role: 'OPS-FIX', count: 1 }, { role: 'OPS-PM', count: 1 }, { role: 'OPS-ACCT', count: 1 }] },
      { template: 'support', staff: [{ role: 'SUP-HEAD', count: 1 }, { role: 'SUP-T1', count: 1 }, { role: 'SUP-T2', count: 1 }, { role: 'SUP-PM', count: 1 }, { role: 'SUP-QA', count: 1 }, { role: 'SUP-KB', count: 1 }] },
    ],
  },
  {
    key: 'lab',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-PM', count: 1 }, { role: 'OPS-FIX', count: 1 }, { role: 'OPS-INTEG', count: 1 }, { role: 'OPS-ACCT', count: 1 }] },
      { template: 'development', staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ARCH', count: 1 }, { role: 'DEV-ENG', count: 2 }, { role: 'DEV-DOCS', count: 1 }, { role: 'DEV-PM', count: 1 }, { role: 'DEV-REV', count: 1 }, { role: 'DEV-SEC', count: 1 }, { role: 'DEV-TEST', count: 1 }, { role: 'DEV-OPS', count: 1 }] },
      { template: 'business_development', staff: [{ role: 'BIZ-HEAD', count: 1 }, { role: 'BIZ-ANALYST', count: 1 }, { role: 'BIZ-PM', count: 1 }, { role: 'BIZ-REV', count: 1 }, { role: 'BIZ-PARTNER', count: 1 }] },
    ],
  },
  {
    key: 'video_studio',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-PM', count: 1 }, { role: 'OPS-FIX', count: 1 }, { role: 'OPS-INTEG', count: 1 }, { role: 'OPS-ACCT', count: 1 }] },
      { template: 'video_production', staff: [{ role: 'VID-HEAD', count: 1 }, { role: 'VID-WRITE', count: 1 }, { role: 'VID-BOARD', count: 1 }, { role: 'VID-KEEP', count: 1 }, { role: 'VID-GEN', count: 1 }, { role: 'VID-EDIT', count: 1 }, { role: 'VID-QA', count: 1 }, { role: 'VID-PM', count: 1 }] },
    ],
  },
  {
    key: 'home',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-PM', count: 1 }, { role: 'OPS-FIX', count: 1 }, { role: 'OPS-INTEG', count: 1 }, { role: 'OPS-ACCT', count: 1 }] },
      { template: 'home_devices', staff: [{ role: 'HOM-HEAD', count: 1 }, { role: 'HOM-NET', count: 1 }, { role: 'HOM-SMART', count: 1 }, { role: 'HOM-PM', count: 1 }] },
      { template: 'household', staff: [{ role: 'HHD-HEAD', count: 1 }, { role: 'HHD-SUPPLY', count: 1 }, { role: 'HHD-BILLS', count: 1 }, { role: 'HHD-CAL', count: 1 }, { role: 'HHD-PM', count: 1 }] },
    ],
  },
];
