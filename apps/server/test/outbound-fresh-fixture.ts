import { company as companyWithDepartments } from './department-owner-fixture.js';

export const company = () => companyWithDepartments();
export type C = Awaited<ReturnType<typeof company>>;
