import { DEV_ORG, TASK_DETAIL } from './api-mock';

import { ECHELON_WORKFLOW } from './echelon-workflow';
export { ECHELON_WORKFLOW } from './echelon-workflow';

const department = DEV_ORG.departments[0]!;
const member = department.employees[1]!;
export const ECHELON_ORG = {
  ...DEV_ORG,
  departments: [{
    ...department,
    employees: [
      ...department.employees,
      { ...member, id: 'reviewer', name: 'Rita', roleId: 'DEV-REV' },
      { ...member, id: 'tester', name: 'Tom', roleId: 'DEV-TEST' },
      { ...member, id: 'security', name: 'Sam', roleId: 'DEV-SEC' },
    ],
  }],
};

/* A legacy gate index deliberately disagrees with the workflow. */
export const ECHELON_TASK = { ...TASK_DETAIL, workflow: ECHELON_WORKFLOW, assignee: TASK_DETAIL.executor };
