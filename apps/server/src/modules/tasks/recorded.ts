import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { repoAt } from '../departments/repository.js';
import { filesOf } from './file-views.js';
import { refuse, type Task } from './state.js';

/* Where the result of work that is not code is recorded, so a colleague finds it and the task can close on it (#1942): a
   path in the repository of the task's department, or the name of a file attached to the task. A hand-in of a document,
   of turnkey work that changed no code, and of a group names it, and is refused without it. */
const PATH_MAX = 500;

/* A path inside a repository: relative, with no way out of it, as the department's repository keeps files. */
const safePath = (path: string): boolean =>
  !path.startsWith('/') && !/[\\\0]/.test(path) && !/^[a-z]:/i.test(path) && !path.split('/').some(part => part === '..' || part === '');

export const Recorded = z.union([
  z.strictObject({ path: z.string().trim().min(1).max(PATH_MAX).describe("A path in the department's repository, such as reports/2026-11-23.md.") }),
  z.strictObject({ file: z.string().trim().min(1).max(255).describe('The name of a file attached to the task.') }),
]).describe("Where the result is recorded: recorded.path, a path in the department's repository, or recorded.file, the name of a file attached to the task.");
export type Recorded = z.infer<typeof Recorded>;

const WHERE = 'name where the result is recorded: recorded.path, a path in the department\'s repository, or recorded.file, the name of a file attached to the task';

/* What was named, or the refusal: nothing named; a path that leaves the repository, or in a department that keeps none; a file
   the task does not hold. */
export async function requireRecorded(ctx: Pick<Ctx, 'db'> & Partial<Pick<Ctx, 'config'>>, task: Task, recorded: Recorded | undefined): Promise<Recorded> {
  if (!recorded) throw refuse(400, 'task_invalid', `The result of #${task.number} is not code, so ${WHERE}. Without it the hand-in is refused.`);
  if ('file' in recorded) {
    if (!(await filesOf(ctx.db, task.id)).some(file => file.name === recorded.file)) throw refuse(409, 'task_invalid', `#${task.number} holds no file named ${recorded.file}. Attach it to the task first, or ${WHERE}.`);
    return recorded;
  }
  if (!safePath(recorded.path)) throw refuse(400, 'task_invalid', `${recorded.path} is no path inside a repository: give it relative, with no ".." and no backslash.`);
  if (!ctx.config || !(await repoAt({ db: ctx.db, config: ctx.config }, [task.productId, task.departmentId]))) throw refuse(409, 'task_invalid', `The department of #${task.number} keeps no repository to hold ${recorded.path}. Attach the result to the task and name the file with recorded.file.`);
  return recorded;
}
