import { useId, useState } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT, type Language } from '../i18n';
import type { Department, Employee, Team } from '../types';
import { employeeKind, WorkerMark } from './WorkerMark';
import { say } from '@hornhoof/protocol';

type EmployeeGroup = { key: string; title: string; members: Employee[] };

async function runAction(onFail: (err: unknown) => void, work: () => Promise<unknown>) {
  onFail(null);
  try {
    await work();
  } catch (err) {
    onFail(err);
  }
}

/* Groups a department's employees for its list: each sub-unit under its own name first, then pipeline roles in order. */
export function employeeGroups(d: Department, language: Language, othersLabel: string): EmployeeGroup[] {
  const members = d.employees.filter(e => e.kind !== 'head');
  const teamIds = new Set(d.teams.map(t => t.id));
  const byTeam = d.teams
    .map(tm => ({ key: `team:${tm.id}`, title: tm.name, members: members.filter(e => e.teamId === tm.id) }))
    .filter(g => g.members.length > 0);
  const inPipe = members.filter(e => !e.teamId || !teamIds.has(e.teamId));
  const known = new Set(d.roles.filter(r => inPipe.some(e => e.roleId === r.id)).map(r => r.id));
  const byRole = d.roles
    .filter(r => known.has(r.id))
    .map(r => ({ key: r.id, title: say(r.title, language), members: inPipe.filter(e => e.roleId === r.id) }));
  const loose = inPipe.filter(e => !e.roleId || !known.has(e.roleId));
  return loose.length ? [...byTeam, ...byRole, { key: 'others', title: othersLabel, members: loose }] : [...byTeam, ...byRole];
}

export function DeptEmployeeList({ department: d, company }: { department: Department; company: boolean }) {
  const t = useT();
  const { language } = useLanguage();
  const id = useId();
  const [failure, setFailure] = useState<unknown>(null);
  const groups = employeeGroups(d, language, t.dept.others);
  if (!groups.length) return null;
  const canMove = company && d.teams.length > 0;
  return (
    <section aria-labelledby={`${id}-emp`}>
      <h3 id={`${id}-emp`}>{t.dept.members}</h3>
      {groups.map(g => (
        <div key={g.key} className="dv-emp-g">
          <h4>{g.title}</h4>
          <ul className="dv-list">
            {g.members.map(e => (
              <li key={e.id}>
                <span className="worker-name"><WorkerMark kind={employeeKind(e.turnkey)} /><b dir="auto">{e.name}</b></span>
                {canMove && (
                  <select
                    aria-label={t.dept.subUnitOf(e.name)}
                    value={e.teamId ?? ''}
                    onChange={ev => void runAction(setFailure, () => api.patch(`/api/agents/${e.id}`, { team: ev.target.value || null }))}
                  >
                    <option value="">{t.dept.inPipeline}</option>
                    {d.teams.map(tm => (
                      <option key={tm.id} value={tm.id}>
                        {tm.name}
                      </option>
                    ))}
                  </select>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {failure !== null && (
        <p className="alert" role="alert">
          {errorText(t, failure)}
        </p>
      )}
    </section>
  );
}

/* Whether the sub-unit's members each do a task alone from start to finish; tasks given from then on follow it. */
function TurnkeyMark({ departmentId, team, onFail }: { departmentId: string; team: Team; onFail: (err: unknown) => void }) {
  const t = useT();
  return (
    <label className="check">
      <input type="checkbox" checked={team.turnkey} onChange={e => void runAction(onFail, () => api.patch(`/api/departments/${departmentId}/teams/${team.id}`, { turnkey: e.target.checked }))} />
      <span>
        <b>{t.dept.turnkey}</b>
        <small>{t.dept.turnkeyHint}</small>
      </span>
    </label>
  );
}

function SubUnitRow({ departmentId, team, onFail }: { departmentId: string; team: Team; onFail: (err: unknown) => void }) {
  const t = useT();
  const id = useId();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(team.name);
  async function save() {
    await runAction(onFail, async () => {
      await api.patch(`/api/departments/${departmentId}/teams/${team.id}`, { name: name.trim() });
      setRenaming(false);
    });
  }
  return (
    <li>
      {renaming ? (
        <div className="f">
          <label className="sr" htmlFor={id}>
            {t.dept.subUnitName}
          </label>
          <input id={id} value={name} onChange={e => setName(e.target.value)} />
          <button className="btn small" type="button" onClick={() => void save()}>
            {t.common.save}
          </button>
        </div>
      ) : (
        <>
          <b>{team.name}</b>
          <TurnkeyMark departmentId={departmentId} team={team} onFail={onFail} />
          <div className="f">
            <button className="btn small ghost" type="button" onClick={() => { setName(team.name); setRenaming(true); }}>
              {t.dept.renameSubUnit}
            </button>
            <button className="btn small ghost" type="button" onClick={() => void runAction(onFail, () => api.del(`/api/departments/${departmentId}/teams/${team.id}`))}>
              {t.dept.deleteSubUnit}
            </button>
          </div>
        </>
      )}
    </li>
  );
}

export function DeptSubUnits({ department: d, company }: { department: Department; company: boolean }) {
  const t = useT();
  const id = useId();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [failure, setFailure] = useState<unknown>(null);
  if (!company) return null;
  async function create() {
    await runAction(setFailure, async () => {
      await api.post(`/api/departments/${d.id}/teams`, { name: name.trim() });
      setName('');
      setAdding(false);
    });
  }
  return (
    <section aria-labelledby={`${id}-sub`}>
      <div className="dv-h">
        <h3 id={`${id}-sub`}>{t.dept.subUnits}</h3>
        {!adding && (
          <button className="btn small ghost" type="button" onClick={() => setAdding(true)}>
            {t.dept.newSubUnit}
          </button>
        )}
      </div>
      {d.teams.length > 0 ? (
        <ul className="dv-list">
          {d.teams.map(tm => (
            <SubUnitRow key={tm.id} departmentId={d.id} team={tm} onFail={setFailure} />
          ))}
        </ul>
      ) : (
        <p className="muted">{t.dept.noSubUnits}</p>
      )}
      {adding && (
        <div className="f">
          <label className="sr" htmlFor={`${id}-new`}>
            {t.dept.subUnitName}
          </label>
          <input id={`${id}-new`} value={name} onChange={e => setName(e.target.value)} />
          <button className="btn small" type="button" onClick={() => void create()}>
            {t.dept.addSubUnit}
          </button>
        </div>
      )}
      {failure !== null && (
        <p className="alert" role="alert">
          {errorText(t, failure)}
        </p>
      )}
    </section>
  );
}
