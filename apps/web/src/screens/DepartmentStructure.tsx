import { useId, type MouseEvent } from 'react';
import { deptLabel, useLanguage, useT } from '../i18n';
import { routePath } from '../routes';
import { localPipeline } from '../tasks';
import { modelLine } from '../ui/Chip';
import { OneShotMarks } from '../ui/TaskWorkflow';
import type { Department, DepartmentPipeline, DepartmentStage, Employee, EmployeeStatus } from '../types';

const CELL: Record<EmployeeStatus, string> = { working: 'w', queued: 'q', handed: 'r', waiting: 'h', idle: '', off: 'o' };

type Props = { department: Department; onOpen(id: string): void; onOpenDepartment?(id: string): void };

function AgentPlace({ employee, position, onOpen }: { employee?: Employee; position: string; onOpen(id: string): void }) {
  const t = useT();
  const model = employee && (employee.modelName || employee.model) ? modelLine(t, employee) : t.dept.noModelYet;
  const name = employee?.name || position;
  return <div className="dv-agent-place">
    <span className={`cell ${CELL[employee?.status ?? 'off']}`} role="img" aria-label={t.workers.permanent} title={t.workers.permanent} />
    <div>
      {employee && employee.opens !== false
        ? <button type="button" className="linkish" onClick={() => onOpen(employee.id)}><bdi>{name}</bdi></button>
        : <bdi>{name}</bdi>}
      {position !== name && <small><bdi>{position}</bdi></small>}
      <small><bdi>{model}</bdi></small>
      {employee && <small>{t.dept.status[employee.status]}</small>}
    </div>
  </div>;
}

function holdersOf(employees: Employee[], stage: DepartmentStage): Employee[] {
  const ownerId = stage.owner?.id;
  if (ownerId) return employees.filter(e => e.id === ownerId);
  return stage.ownerRole ? employees.filter(e => !e.teamId && e.roleId === stage.ownerRole) : [];
}

function DepartmentLink({ target, open }: { target: Pick<Department, 'id' | 'name' | 'templateKey'>; open?: Props['onOpenDepartment'] }) {
  const t = useT();
  function follow(event: MouseEvent<HTMLAnchorElement>) {
    if (!open || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open(target.id);
  }
  return <a href={routePath({ kind: 'department', id: target.id })} onClick={follow}><bdi>{deptLabel(t, target)}</bdi></a>;
}

function PipelineRoute({ pipeline, department, onOpen, onOpenDepartment }: Props & { pipeline: DepartmentPipeline }) {
  const t = useT(), { language } = useLanguage(), id = useId();
  const route = localPipeline(t, pipeline);
  const calls = department.calls?.filter(call => call.pipelineId === route.id || (call.pipelineId === null && route.isDefault));
  return <section className="dv-route" aria-labelledby={`${id}-route`}>
    <h4 id={`${id}-route`} dir="auto">{route.name}</h4>
    {route.department.id !== department.id && <p className="muted" dir="auto">{route.department.name}</p>}
    <ol className="dv-stages" role="list">
      {route.stages.map(stage => {
        const holders = holdersOf(department.employees, stage);
        const position = stage.ownerTitle?.[language] ?? holders[0]?.title?.[language] ?? stage.ownerRole ?? stage.owner?.name ?? t.workers.permanent;
        return <li key={stage.id}>
          <div className="dv-stage">
            <h5 dir="auto">{stage.name}</h5>
            {holders.length ? holders.map(employee => <AgentPlace key={employee.id} employee={employee} position={position} onOpen={onOpen} />)
              : <AgentPlace position={position} onOpen={onOpen} />}
            {stage.oneShot && <OneShotMarks stage={{ ...stage.oneShot, stage: stage.echelon }} calls={calls} position={position} />}
            {stage.handoffs?.map(target => <div key={target.id} className="dv-stage-link"><DepartmentLink target={target} open={onOpenDepartment} /></div>)}
          </div>
        </li>;
      })}
    </ol>
  </section>;
}

export function DepartmentStructure(props: Props) {
  const { department: d, onOpen } = props;
  const t = useT(), { language } = useLanguage();
  const pipelines = d.pipelines ?? [];
  const assigned = new Set(pipelines.flatMap(p => p.stages.flatMap(stage => holdersOf(d.employees, stage).map(e => e.id))));
  const remaining = d.employees.filter(e => !e.teamId && !assigned.has(e.id));
  const agent = (employee: Employee) => <AgentPlace key={employee.id} employee={employee} position={employee.title?.[language] ?? employee.name} onOpen={onOpen} />;
  return <section className="dv-structure" aria-label={t.dept.structure}>
    {d.products.length > 0 && <div>
      <h3>{t.dept.products}</h3>
      <ul className="dv-products" role="list">{d.products.map(product => <li key={product.id} dir="auto">{product.name}</li>)}</ul>
    </div>}
    {pipelines.length > 0 && <div>
      <h3>{t.tracker.side.pipelines}</h3>
      <div className="dv-structure-grid">{pipelines.map(pipeline => <PipelineRoute key={pipeline.id} {...props} pipeline={pipeline} />)}</div>
    </div>}
    {(remaining.length > 0 || d.teams.length > 0) && <div>
      <h3>{t.dept.members}</h3>
      <div className="dv-structure-grid">
        {remaining.length > 0 && <div className="dv-stage">{remaining.map(agent)}</div>}
        {d.teams.map(team => <div className="dv-stage" key={team.id}>
          <h4 dir="auto">{team.name}</h4>
          {d.employees.filter(e => e.teamId === team.id).map(agent)}
        </div>)}
      </div>
    </div>}
    {d.employees.length === 0 && pipelines.length === 0 && <p className="muted">{t.dept.noMembers}</p>}
  </section>;
}
