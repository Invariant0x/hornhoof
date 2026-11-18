import { fileURLToPath, URL as FileURL } from 'node:url';
import { COMPANY_TEMPLATES, DEPARTMENT_TEMPLATES } from '@hornhoof/protocol/catalog';
import { catalogRoute, loadTemplates, type Role } from '../../../server/src/modules/templates/load';
import type { Department, DepartmentPipeline, Employee, Org } from '../../src/types';
import { MOONFERN_ORG } from './agents';
import { MAYA_VIEW } from './people';

const STARTUP = COMPANY_TEMPLATES.find(kit => kit.key === 'startup')!;
const TEMPLATES = fileURLToPath(new FileURL('../../../../templates/', import.meta.url));

function hire(role: Role, id: string, count: number, index: number, teamId?: string): Employee {
  return {
    id, roleId: role.id, title: role.title,
    name: count === 1 ? role.title.en : `${role.title.en} ${index + 1}`,
    kind: role.kind === 'head' ? 'head' : 'worker', teamId, turnkey: Boolean(teamId),
    model: '', modelName: null, provider: null, effort: null, state: 'needs_subscription', status: 'off',
    on: true, timer: role.timer?.minutes ?? null, task: null, context: null, program: null, alarm: null,
    retry: null, failure: null,
  };
}

/* The Startup kit before anyone connects a model. Read the same role and route catalogs as setup. */
export function starterKitOrg(companyName: string): Org {
  const templates = loadTemplates(TEMPLATES);
  const targets = STARTUP.departments.map(seed => ({ id: `kit-${seed.template}`, name: seed.name ?? null, templateKey: seed.template }));
  const departments: Department[] = STARTUP.departments.map((seed, index) => {
    const target = targets[index]!;
    const roles = templates.roster(seed.template);
    const hired = (staff: typeof seed.staff, teamId?: string) => staff.flatMap(({ role, count }) =>
      Array.from({ length: count }, (_, i) => hire(templates.roles.get(role)!, `${teamId ?? target.id}-${role}-${i}`, count, i, teamId)));
    const teams = templates.teamsOf(seed.template).map(team => ({ ...team, id: `${target.id}-${team.id}` }));
    const employees = [...hired(seed.staff), ...teams.flatMap(team => hired(team.members, team.id))];
    const catalog = templates.catalogs.get(seed.template);
    const pipelines: DepartmentPipeline[] = (catalog?.pipelines ?? []).map(pipeline => {
      const route = catalogRoute(templates, seed.template, pipeline.key);
      return {
        id: pipeline.key, catalogKey: pipeline.key, department: { id: target.id, name: target.name ?? seed.template },
        name: pipeline.name, why: pipeline.why, isDefault: pipeline.key === catalog?.default, archived: false, version: 1,
        stages: pipeline.stages.map((stage, i) => {
          const oneShot = route.stages.find(step => step.stage === stage.echelon)?.oneShot;
          return {
            id: `${pipeline.key}-${i}`, parentId: i ? `${pipeline.key}-${i - 1}` : null, position: 0,
            name: stage.name, ownerRole: stage.ownerRole, owner: null, ownerTitle: templates.roles.get(stage.ownerRole)?.title,
            echelon: stage.echelon,
            ...(oneShot ? { oneShot: { fanOut: oneShot.fanOut, judge: oneShot.judge !== null } } : {}),
            handoffs: targets.filter(department => stage.handoffTo?.includes(department.templateKey)),
          };
        }),
      };
    });
    return {
      ...target, roleCode: DEPARTMENT_TEMPLATES.find(dept => dept.key === seed.template)!.roleCode,
      about: '', people: [], roles, employees, teams: teams.map(team => ({
        id: team.id, name: team.title.en, about: team.description.en, stage: 0, gate: false, turnkey: team.turnkey,
      })),
      products: (seed.products ?? []).map((name, i) => ({ id: `${target.id}-product-${i}`, name })),
      pipelines, calls: [], agents: { total: employees.length, working: 0 },
    };
  });
  const base = MOONFERN_ORG.orchestrator!;
  return {
    company: { ...MOONFERN_ORG.company, name: companyName },
    orchestrator: { ...base, name: 'Orchestrator', model: '', subscription: null, machine: null, program: null, planned: false, context: null },
    people: [MAYA_VIEW], departments, agents: { total: departments.reduce((n, dept) => n + dept.agents.total, 0), working: 0 },
  };
}
