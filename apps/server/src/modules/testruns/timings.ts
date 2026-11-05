import type { Db } from '../../db/client.js';
import type { Tx } from '../tasks/engine.js';

/* Placeholder until the timing tests come next. */
export async function keepTimings(_db: Db | Tx, _companyId: string, _taskIds: string[]): Promise<void> {}
