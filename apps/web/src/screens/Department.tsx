import { useId } from 'react';
import { deptLabel, useLanguage, useT } from '../i18n';
import { PROVIDER_NAMES } from '../providers';
import type { Department, Employee, Me } from '../types';
import { Edge } from '../ui/Edge';

type Props = { me: Me; department: Department; selected: string | null; onBack(): void; onHire(): void; onOpen(agentId: string): void };

function EmployeeCard({ e, on, onOpen }: { e: Employee; on: boolean; onOpen(id: string): void }) {
  const t = useT();
  const { language } = useLanguage();
  return (
    <button type="button" className={`emp${on ? ' on' : ''}`} aria-pressed={on} onClick={() => onOpen(e.id)}>
      <Edge cut={10} corner={e.kind === 'head'}>
        <b className="emp-name">{e.name}</b>
        <span className="emp-role">{e.title?.[language] ?? e.roleId}</span>
        <span className="emp-model">{[e.model || t.agent.default, e.provider && PROVIDER_NAMES[e.provider]].filter(Boolean).join(', ')}</span>
        <span className="emp-state">
          <i className={`dot ${e.state}`} />
          <span>{t.dept.states[e.state]}</span>
        </span>
      </Edge>
    </button>
  );
}

/* Inside a department: its head on top, the members below, its products and the people who reach it at the side. */
export function DepartmentView({ me, department: d, selected, onBack, onHire, onOpen }: Props) {
  const t = useT();
  const id = useId();
  const head = d.employees.find(e => e.kind === 'head');
  const members = d.employees.filter(e => e.kind !== 'head');

  return (
    <div className="dview">
      <header className="dv-top">
        <button className="btn small ghost" type="button" onClick={onBack}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
          {t.dept.back}
        </button>
        <div className="dv-title">
          <h2>{deptLabel(t, d)}</h2>
          <span className="role">{d.roleCode}</span>
        </div>
        {me.person.scopeKind === 'company' && (
          <button className="btn" type="button" onClick={onHire}>
            {t.dept.hire}
          </button>
        )}
      </header>
      <div className="dv-body">
        <div className="dv-main">
          <section aria-labelledby={`${id}-head`}>
            <h3 id={`${id}-head`}>{t.dept.head}</h3>
            {head ? <EmployeeCard e={head} on={selected === head.id} onOpen={onOpen} /> : <p className="muted">{t.dept.noHead}</p>}
          </section>
          <section aria-labelledby={`${id}-members`}>
            <h3 id={`${id}-members`}>{t.dept.members}</h3>
            {members.length ? (
              <ul className="dv-grid">
                {members.map(e => (
                  <li key={e.id}>
                    <EmployeeCard e={e} on={selected === e.id} onOpen={onOpen} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{t.dept.noMembers}</p>
            )}
          </section>
        </div>
        <div className="dv-side">
          {d.products.length > 0 && (
            <section aria-labelledby={`${id}-products`}>
              <h3 id={`${id}-products`}>{t.dept.products}</h3>
              <ul>
                {d.products.map(p => (
                  <li key={p.id}>{p.name}</li>
                ))}
              </ul>
            </section>
          )}
          <section aria-labelledby={`${id}-people`}>
            <h3 id={`${id}-people`}>{t.dept.people}</h3>
            {d.people.length ? (
              <ul>
                {d.people.map(p => (
                  <li key={p.id}>
                    <b>{p.name}</b>
                    {p.title && <small>{p.title}</small>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{t.dept.noPeople}</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
