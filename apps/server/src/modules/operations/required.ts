import { PROGRAM_OPERATOR_ROLE } from '@hornhoof/protocol/program-operator';

export { PROGRAM_OPERATOR_ROLE };

/* Who Operations always has, in every company: people cannot leave them out of a card or remove the last one, and
   Hornhoof hires whoever is missing. */
export const REQUIRED_OPERATIONS_ROLES = ['OPS-HEAD', 'OPS-WATCH', 'OPS-BUGS', PROGRAM_OPERATOR_ROLE] as const;
type RequiredRole = (typeof REQUIRED_OPERATIONS_ROLES)[number];

export const isRequiredRole = (role: string): role is RequiredRole => (REQUIRED_OPERATIONS_ROLES as readonly string[]).includes(role);

type Dept = { templateKey: string | null; parentId: string | null };
export const isOperations = (dept: Dept) => dept.templateKey === 'operations' && !dept.parentId;

export type Holder = { kind: string; roleKey: string | null };

/* An old head with no role key of its own holds the head's place all the same. */
export const holds = (employee: Holder, role: RequiredRole) => (role === 'OPS-HEAD' ? employee.kind === 'head' : employee.roleKey === role);

export const missingRoles = (staff: Holder[]): RequiredRole[] => REQUIRED_OPERATIONS_ROLES.filter(role => !staff.some(employee => holds(employee, role)));

/* The required roles nobody holds that these lines do not hire either. */
export const leftOut = (staff: Holder[], lines: { role: string }[]): RequiredRole[] => missingRoles(staff).filter(role => !lines.some(line => line.role === role));

/* Who holds a role, by name, when it is required and someone does. */
export const holderOf = <E extends Holder & { name: string }>(staff: E[], role: string): E | undefined => (isRequiredRole(role) ? staff.find(employee => holds(employee, role)) : undefined);
