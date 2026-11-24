import { z } from 'zod';
import { Absent, Unread, shown, type Json, type Run } from './github-api.js';
import type { RepoAddress } from './refs.js';

/* Which workflow of a repository is its release workflow, the one whose run on a commit says the commit may be released. A
   person names it, by its path, in the repository settings. Hornhoof never infers it: not from the repository's releases or
   tags, which any token with write access can publish, and not from which workflow can be started by hand or went green. Where
   none is named there is none, and a release is refused until one is.

   The release workflow also keeps a contract, so that its run proves the whole suite and not a part of it. It starts on
   workflow_dispatch with a boolean input named full, which Hornhoof sets when it starts the workflow, and with full no earlier
   result narrows what it runs: no status that says tests passed and no earlier commit's tests. Its run-name ends with
   (full run) when full is set. A run counts for a release only if it was started by hand and its title says so: a run of a
   push or of a pull request, or one by hand without full, may have run only the tests a change reached. */
export type Wf = { id: number; name: string; path: string };
export type Chosen = { workflow: Wf } | { no: string };

/* The input Hornhoof starts the release workflow with, and the end of the title of a run it asked a full one of. */
export const FULL_INPUT = 'full';
const FULL_TITLE = /\(full run\)$/;

/* What a refusal says to name the workflow, without more: the repository settings are where a person does. */
export const NAME_IT = 'name the release workflow in the repository settings.';

const Workflow = z.object({ id: z.number().int().positive(), name: z.string().min(1), path: z.string().min(1), state: z.string().min(1) });

export const nameOf = (workflow: Wf): string => shown(`${workflow.name} (${workflow.path})`);

/* Whether a run of the release workflow ran everything: started by hand, with the input full. Only the event and the title the
   workflow wrote for it say so: GitHub gives no run's inputs. */
export const isFullRun = (run: Run): boolean => run.event === 'workflow_dispatch' && FULL_TITLE.test(run.display_title ?? '');

const notActive = (path: string): string => `${shown(path)} is not an active workflow of the repository: name its release workflow in the repository settings.`;

/* The release workflow of the repository: the workflow the repository settings name by its path, asked of GitHub by its file name,
   which must be active and at exactly that path. */
export async function releaseWorkflowOf(json: Json, repo: RepoAddress, name: string, timeoutMs: number): Promise<Chosen> {
  const named = repo.releaseWorkflow?.trim();
  if (!named) return { no: NAME_IT };
  let answer: unknown;
  try {
    answer = await json(repo, name, `actions/workflows/${encodeURIComponent(named.slice(named.lastIndexOf('/') + 1))}`, timeoutMs);
  } catch (error) {
    if (error instanceof Absent) return { no: notActive(named) };
    throw error;
  }
  const workflow = Workflow.safeParse(answer);
  if (!workflow.success) throw new Unread('its release workflow was not readable');
  const { id, name: title, path, state } = workflow.data;
  return path === named && state === 'active' ? { workflow: { id, name: title, path } } : { no: notActive(named) };
}
