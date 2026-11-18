import { useId } from 'react';
import { deptLabel, teamLabel, useLanguage, useT, type Language, type Messages } from '../i18n';
import type { AccessInput, AccessView, Org } from '../types';

/* A person's access as the picker holds it. */
export const accessInput = (a: AccessView): AccessInput => (a.whole ? { whole: true } : { departments: a.departments.map(d => d.id), teams: a.teams.map(t => t.id) });

/* What a person reaches in a few words: "Whole company", or departments and teams by name in the person's language. */
export function accessText(t: Messages, a: AccessView, org: Org | null, language?: Language): string {
  if (a.whole) return t.people.wholeCompany;
  const dept = (id: string) => org?.departments.find(d => d.id === id);
  return [
    ...a.departments.map(d => {
      const known = dept(d.id);
      return known ? deptLabel(t, known) : d.name;
    }),
    ...a.teams.map(team => {
      const known = dept(team.departmentId);
      const own = known?.teams.find(x => x.id === team.id);
      const name = own && language ? teamLabel(own, language) : team.name;
      return known ? `${deptLabel(t, known)} / ${name}` : name;
    }),
  ].join(', ');
}

export const accessEmpty = (v: AccessInput) => !('whole' in v) && !v.departments.length && !v.teams.length;

/* Whole company, or departments with their teams below them. A ticked department includes its teams. A row of a form's grid:
   its name in the label column, the ticks beside it. */
export function AccessPicker({ org, value, onChange }: { org: Org | null; value: AccessInput; onChange(v: AccessInput): void }) {
  const t = useT();
  const { language } = useLanguage();
  const id = useId();
  const whole = 'whole' in value;
  const list = 'whole' in value ? { departments: [], teams: [] } : value;
  const depts = org?.departments ?? [];
  /* Kept in the order of the map, whatever order they were ticked in. */
  function pick(departments: Set<string>, teams: Set<string>) {
    onChange({
      departments: depts.filter(d => departments.has(d.id)).map(d => d.id),
      teams: depts.flatMap(d => (departments.has(d.id) ? [] : d.teams.filter(x => teams.has(x.id)).map(x => x.id))),
    });
  }
  function toggle(set: string[], id: string, on: boolean): Set<string> {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  }

  return (
    <div className="field access" role="group" aria-labelledby={`${id}-access`}>
      <span className="label" id={`${id}-access`}>{t.people.access}</span>
      <div className="field-control">
        <label>
          <input type="checkbox" checked={whole} onChange={e => onChange(e.target.checked ? { whole: true } : { departments: [], teams: [] })} />
          {t.people.wholeCompany}
        </label>
        {!whole && (
          <ul className="access-list">
            {depts.map(d => {
              const on = list.departments.includes(d.id);
              return (
                <li key={d.id}>
                  <label>
                    <input type="checkbox" checked={on} onChange={e => pick(toggle(list.departments, d.id, e.target.checked), new Set(list.teams))} />
                    {deptLabel(t, d)}
                  </label>
                  {/* Its head reads Hornhoof's whole database, so this tick reaches more than the department. */}
                  {d.templateKey === 'operations' && <p className="hint">{t.people.opsReadsAll}</p>}
                  {d.teams.length > 0 && (
                    <ul>
                      {d.teams.map(team => (
                        <li key={team.id}>
                          <label>
                            <input type="checkbox" checked={on || list.teams.includes(team.id)} disabled={on} onChange={e => pick(new Set(list.departments), toggle(list.teams, team.id, e.target.checked))} />
                            {teamLabel(team, language)}
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="hint">{t.people.accessHint}</p>
        {accessEmpty(value) && <p className="bad">{t.people.accessEmpty}</p>}
      </div>
    </div>
  );
}
