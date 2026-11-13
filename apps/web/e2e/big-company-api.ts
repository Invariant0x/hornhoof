import type { Department, Employee, Org, PersonView } from '../src/types';
import { ME } from './api';

const STATUSES = ['working', 'idle', 'queued', 'waiting', 'handed', 'idle', 'working', 'off'] as const;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const employee = (dept: number, i: number): Employee => ({
  id: uuid(1000 + dept * 100 + i), name: `Agent ${dept + 1}.${i + 1}`, roleId: i === 0 ? `r${dept}-head` : `r${dept}-m${i % 3}`, teamId: i > 6 ? uuid(500 + dept * 10 + (i % 2)) : null,
  title: { en: i === 0 ? 'Head' : 'Developer', ru: i === 0 ? 'Глава' : 'Разработчик' }, kind: i === 0 ? 'head' : 'worker', model: 'claude-opus-5-5', modelName: 'Opus 5.5',
  provider: 'claude', effort: null, state: 'working', status: STATUSES[(dept + i) % STATUSES.length]!, on: true, timer: null,
  task: null, context: 0.4, program: null, alarm: null, retry: null, failure: null, opens: true,
});

const person = (n: number, whole: boolean, depts: string[]): PersonView & { deputy?: boolean; departments?: string[] } => ({
  id: `p${n}`, name: `Person ${n}`, email: `p${n}@acme.com`, title: whole ? 'Director' : 'Manager', status: 'active', isOwner: false,
  access: { whole, departments: depts.map(id => ({ id, name: id })), teams: [] }, pendingDecisions: n % 3 ? 0 : 2, ...(whole ? {} : { deputy: depts.length > 1, departments: depts }),
});

/* A company of 12 departments and 120 agents, as large companies have: products, teams, people of a department, a deputy
   over two departments, heads and members of four roles, and every state an agent is in. */
export function bigCompany(): Org {
  const departments: Department[] = Array.from({ length: 12 }, (_, d) => {
    const id = uuid(d + 1);
    const employees = Array.from({ length: 10 }, (_, i) => employee(d, i));
    return {
      id, name: `Department ${d + 1}`, templateKey: null, roleCode: `D${d + 1}`, about: '', agents: { total: 10, working: employees.filter(e => e.status === 'working').length },
      products: d % 3 === 0 ? [{ id: uuid(300 + d), name: `Product ${d + 1}` }] : [],
      teams: d % 2 ? [0, 1].map(t => ({ id: uuid(500 + d * 10 + t), name: `Team ${d + 1}.${t + 1}`, about: '', stage: t, gate: false, turnkey: false })) : [],
      people: d % 4 === 0 ? [person(100 + d, false, [id])] : [],
      employees,
      roles: [
        { id: `r${d}-head`, title: { en: 'Head', ru: 'Глава' }, description: { en: '', ru: '' }, kind: 'head', gate: null },
        ...[0, 1, 2].map(m => ({ id: `r${d}-m${m}`, title: { en: `Role ${m + 1}`, ru: `Роль ${m + 1}` }, description: { en: '', ru: '' }, kind: 'member' as const, gate: m })),
      ],
      current: d % 2 ? { id: `t${d}`, number: 700 + d, title: `Work of department ${d + 1}` } : null,
    };
  });
  return {
    company: ME.company,
    orchestrator: { id: 'a1', name: 'Orchestrator', model: 'claude-opus-5-5', effort: null, subscription: null, context: null, program: null, alarm: null, retry: null, failure: null },
    agents: { total: 120, working: departments.reduce((n, d) => n + d.agents.working, 0) },
    people: [person(1, true, []), person(2, true, []), person(3, false, [uuid(1), uuid(2)])],
    departments,
  };
}
