import { useId } from 'react';
import { errorText, useT, type Messages } from '../i18n';
import { useLive } from '../tasks';
import type { Department, DepartmentBranch, DepartmentBranches } from '../types';
import { useLoadFailure } from './LoadFailure';

const stateOf = (t: Messages, b: DepartmentBranch) => t.dept.branches.state[b.status][b.merged === false ? 'notIn' : 'unknown'];

function BranchList({ branches }: { branches: DepartmentBranch[] }) {
  const t = useT();
  if (!branches.length) return <p className="muted">{t.dept.branches.none}</p>;
  return (
    <ul className="dv-list dv-branches">
      {branches.map(b => (
        <li key={b.branch}>
          <b>#{b.task} {b.title}</b>
          <code>{b.branch}</code>
          <small className="muted">{stateOf(t, b)}</small>
        </li>
      ))}
    </ul>
  );
}

/* Why the branches could not be had, that they are still on the way, why the repository could not say them, and the
   branches themselves. */
function BranchesFound({ found, failure }: { found: DepartmentBranches | undefined; failure: unknown }) {
  const t = useT();
  if (failure !== null) return <p className="alert" role="alert">{errorText(t, failure)}</p>;
  if (!found) return <p className="muted">{t.dept.branches.loading}</p>;
  return (
    <>
      {found.problem && <p className="warn-line" role="status">{found.problem}</p>}
      {(!found.problem || found.branches.length > 0) && <BranchList branches={found.branches} />}
    </>
  );
}

/* Which accepted and handed-in task branches of a department main does not have yet, read from its repository each time the
   people who run it open the department. */
export function DeptBranches({ departmentId }: { departmentId: string }) {
  const t = useT();
  const id = useId();
  const { data: found, failure } = useLive(`/api/departments/${departmentId}/branches`, (branches: DepartmentBranches) => branches, () => false);
  const shown = useLoadFailure(failure);
  return (
    <section aria-labelledby={`${id}-branches`}>
      <h3 id={`${id}-branches`}>{t.dept.branches.title}</h3>
      <p className="muted">{t.dept.branches.hint}</p>
      <BranchesFound found={found} failure={shown} />
    </section>
  );
}

/* The branches of a department, for whoever runs it, where it keeps a repository itself or for one of its products. */
export function DeptBranchesIfKept({ department, shown }: { department: Pick<Department, 'id' | 'repository' | 'products'>; shown: boolean }) {
  return shown && (department.repository || department.products.some(p => p.repository)) ? <DeptBranches departmentId={department.id} /> : null;
}
