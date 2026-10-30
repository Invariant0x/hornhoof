import type { TemplateKey } from './types';

/* The department templates in card order, as the server has them; kept here so the browser does not load the protocol's validators. */
export const TEMPLATES: readonly { key: TemplateKey; roleCode: string; ticked: boolean; always: boolean }[] = [
  { key: 'operations', roleCode: 'OPS', ticked: true, always: true },
  { key: 'development', roleCode: 'DEV', ticked: true, always: false },
  { key: 'marketing', roleCode: 'MKT', ticked: true, always: false },
  { key: 'sales', roleCode: 'SAL', ticked: true, always: false },
  { key: 'business_development', roleCode: 'BIZ', ticked: true, always: false },
  { key: 'design', roleCode: 'DSN', ticked: false, always: false },
  { key: 'support', roleCode: 'SUP', ticked: false, always: false },
  { key: 'finance', roleCode: 'FIN', ticked: false, always: false },
];
