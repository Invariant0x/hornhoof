import type { Ctx } from '../../app.js';

export async function departmentHasWork(_ctx: Pick<Ctx, 'db'>, _companyId: string, _departmentId: string): Promise<boolean> {
  return false;
}
