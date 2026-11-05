import { PIPELINE_SECTIONS, type DepartmentPipeline, type DepartmentReport, type PipelineRow, type PipelineSection } from '@hornhoof/protocol/pipeline-report';
import { useId, useRef, useState, type ReactNode } from 'react';
import { ApiFailure } from '../api';
import { errorText, useT } from '../i18n';
import { useDepartmentPipeline } from '../tasks';
import type { Department } from '../types';
import { changeText, changeTone, comparedLine, comparedTurns, metricLabel, msText, packageTestsText, phasesText, valueText, type Compared } from './tree-pipeline';

function Change({ row, compared }: { row: PipelineRow; compared: Compared }) {
  const t = useT();
  const change = row[compared.change];
  return (
    <span>
      {t.dept.tree.pipe.vs(compared.number)} <span className={changeTone(row.key, change)}>{changeText(t, row.value, row[compared.value], change)}</span>
    </span>
  );
}

function Row({ row, compared }: { row: PipelineRow; compared: Compared[] }) {
  const t = useT();
  const unknown = row.value === null && row.previous === null && row.baseline === null;
  return (
    <li className="pr-row">
      <span className="pr-l">{metricLabel(t, row.key)}</span>
      <span className="pr-v">{valueText(t, row)}</span>
      {!unknown && compared.length > 0 && (
        <span className="pr-c">
          {compared.map(c => <Change key={c.number} row={row} compared={c} />)}
        </span>
      )}
    </li>
  );
}

function Section({ section, rows, compared, children }: { section: PipelineSection; rows: PipelineRow[]; compared: Compared[]; children?: ReactNode }) {
  const P = useT().dept.tree.pipe, id = useId();
  return (
    <section className="pr-sec" aria-labelledby={id}>
      <h4 id={id}>{P.sections[section]}</h4>
      {rows.length > 0 && <ul className="pr-rows">{rows.map(row => <Row key={row.key} row={row} compared={compared} />)}</ul>}
      {children}
    </section>
  );
}

function TimeList({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <>
      <h5 id={id}>{title}</h5>
      <ul className="pr-rows" aria-labelledby={id}>{children}</ul>
    </>
  );
}

function TimeLine({ name, ms, lines, path }: { name: string; ms: number; lines: string[]; path?: boolean }) {
  const t = useT();
  return (
    <li className="pr-row">
      <span className={path ? 'pr-l pr-path' : 'pr-l'}>{name}</span>
      <span className="pr-v">{msText(t, ms)}</span>
      {lines.map(line => <small key={line}>{line}</small>)}
    </li>
  );
}

function TestTimes({ tests }: { tests: DepartmentReport['tests'] }) {
  const t = useT(), P = t.dept.tree.pipe;
  if (!tests.packages.length) return <p className="pr-note">{P.noTests}</p>;
  return (
    <>
      <TimeList title={P.packages}>
        {tests.packages.map(p => {
          const line = [P.fileCount(p.files), ...phasesText(t, p)].join(', ');
          const inside = packageTestsText(t, p);
          return <TimeLine key={p.package} name={p.package} ms={p.totalMs} path lines={inside ? [line, inside] : [line]} />;
        })}
      </TimeList>
      <TimeList title={P.slowFiles}>
        {tests.slowestFiles.map(f => <TimeLine key={`${f.package}/${f.file}`} name={`${f.package}/${f.file}`} ms={f.totalMs} path lines={[phasesText(t, f).join(', ')].filter(Boolean)} />)}
      </TimeList>
      {tests.slowestTests.length > 0 && (
        <TimeList title={P.slowTests}>
          {tests.slowestTests.map(s => <TimeLine key={`${s.package}/${s.file}/${s.name}`} name={s.name} ms={s.ms} lines={[`${s.package}/${s.file}`]} />)}
        </TimeList>
      )}
    </>
  );
}

function ReportHead({ report }: { report: DepartmentPipeline }) {
  const t = useT(), P = t.dept.tree.pipe;
  return (
    <p className="pr-sub">
      <b>{report.turn.title}:</b> {P.source[report.turn.source]}. {comparedLine(t, report)}
    </p>
  );
}

function Sections({ report, department }: { report: DepartmentPipeline; department: DepartmentReport }) {
  const P = useT().dept.tree.pipe, compared = comparedTurns(report);
  const more: Partial<Record<PipelineSection, ReactNode>> = {
    time: department.criticalPath.length > 0 && <p className="pr-note">{P.criticalTasks(department.criticalPath.map(n => `#${n}`).join(', '))}</p>,
    tests: <TestTimes tests={department.tests} />,
  };
  return (
    <>
      <p className="pr-note">{department.described ? P.hasAbout : P.noAbout}</p>
      {PIPELINE_SECTIONS.map(section => {
        const rows = department.rows.filter(row => row.section === section);
        return (rows.length > 0 || section === 'tests') && <Section key={section} section={section} rows={rows} compared={compared}>{more[section]}</Section>;
      })}
    </>
  );
}

/* What stands in the place of a report: it is on its way, or there is none, or asking failed and can be asked again. */
function NoReport({ failure, onRetry }: { failure: unknown; onRetry(): void }) {
  const t = useT(), P = t.dept.tree.pipe;
  const reason = failure instanceof ApiFailure ? failure.reason : undefined;
  if (!failure) return <p>{t.common.loading}</p>;
  if (reason === 'turn_unknown') return <p>{P.noTurn}</p>;
  if (reason === 'department_unknown') return <p>{P.noAccess}</p>;
  return (
    <div className="pr-fail">
      <p role="alert">{errorText(t, failure)}</p>
      <button className="btn" type="button" onClick={onRetry}>{t.app.tryAgain}</button>
    </div>
  );
}

function TurnPicker({ turns, value, onPick }: { turns: number[]; value: number; onPick(turn: number): void }) {
  const t = useT();
  return (
    <label className="pr-turn">
      <span>{t.dept.tree.pipe.turn}</span>
      <select className="sel" value={value} onChange={e => onPick(Number(e.target.value))}>
        {turns.map(n => <option key={n} value={n}>{t.tasks.turn(n)}</option>)}
      </select>
    </label>
  );
}

export function PipelineReport({ department }: { department: Department }) {
  const P = useT().dept.tree.pipe, [picked, setPicked] = useState<number | null>(null);
  const { report, failure, load } = useDepartmentPipeline(department.id, picked);
  /* The picker stays while the next turn loads, or keyboard focus would be lost with it. */
  const turns = useRef<number[]>([]);
  if (report) turns.current = report.turns;
  const value = picked ?? report?.turn.number;
  return (
    <>
      {value !== undefined && <TurnPicker turns={turns.current} value={value} onPick={setPicked} />}
      {report ? (
        <>
          <ReportHead report={report} />
          {report.department ? <Sections report={report} department={report.department} /> : <p>{P.noTasks(report.turn.number)}</p>}
        </>
      ) : <NoReport failure={failure} onRetry={load} />}
    </>
  );
}
