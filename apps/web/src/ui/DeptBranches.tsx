import { useEffect, useId, useState } from 'react';
import { api } from '../api';
import { errorText, useT, type Messages } from '../i18n';
import type { DepartmentBranch, DepartmentBranches } from '../types';

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

/* Which accepted and handed-in task branches of a department main does not have yet, read from its repository each time the
   people who run it open the department. */
export function DeptBranches({ departmentId }: { departmentId: string }) {
  const t = useT();
  const id = useId();
  const [found, setFound] = useState<DepartmentBranches | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    api.get<DepartmentBranches>(`/api/departments/${departmentId}/branches`).then(
      answer => live && setFound(answer),
      err => live && setFailure(err),
    );
    return () => {
      live = false;
    };
  }, [departmentId]);
  return (
    <section aria-labelledby={`${id}-branches`}>
      <h3 id={`${id}-branches`}>{t.dept.branches.title}</h3>
      <p className="muted">{t.dept.branches.hint}</p>
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
      {failure === null && !found && <p className="muted">{t.dept.branches.loading}</p>}
      {found?.problem && <p className="warn-line" role="status">{found.problem}</p>}
      {found && (!found.problem || found.branches.length > 0) && <BranchList branches={found.branches} />}
    </section>
  );
}
