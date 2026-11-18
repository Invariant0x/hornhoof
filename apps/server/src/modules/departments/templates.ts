import type { TemplateKey } from '@hornhoof/protocol';

/* The English text agents read and the server shows where no language is chosen. People see their own language from the web dictionaries. */
export const TEMPLATE_TEXT: Record<TemplateKey, { name: string; description: string }> = {
  operations: {
    name: 'Operations',
    description: 'Always there: sets up tools, accounts, registrations and integrations for the other departments, and fixes what breaks.',
  },
  development: { name: 'Development', description: 'Builds and ships the products: code, tests, releases.' },
  marketing: { name: 'Marketing', description: 'Tells the market about the products: positioning, content, campaigns, launches.' },
  sales: { name: 'Sales', description: 'Finds customers and closes deals.' },
  business_development: { name: 'Business development', description: 'Partnerships, new markets and new lines of business.' },
  design: { name: 'Design', description: 'Interfaces, brand and visual materials.' },
  support: { name: 'Support', description: 'Answers customers and passes what they report to the right department.' },
  finance: { name: 'Finance', description: 'Budget, payments, invoices and reports.' },
  home_devices: { name: 'Home devices', description: 'Looks after the home network and devices: Wi-Fi, routers, smart home, updates and tuning.' },
  household: { name: 'Household', description: 'Runs the household: shopping lists and supplies, bills and subscriptions, chores, the family calendar and reminders. Buying or paying waits for a person.' },
};

/* A typed name as typed; a template department without one by its template's English name. */
export function deptName(d: { name: string | null; templateKey: TemplateKey | null }): string {
  return d.name ?? (d.templateKey ? TEMPLATE_TEXT[d.templateKey].name : '');
}
