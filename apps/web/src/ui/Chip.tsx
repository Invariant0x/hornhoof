import { memo, type MouseEvent } from 'react';
import { useT } from '../i18n';
import { PROVIDER_NAMES } from '../providers';
import type { Employee, EmployeeStatus } from '../types';
import { Bar, percent } from './Bar';
import { Edge } from './Edge';
import { ProviderMark } from './icons';
import { AgentState, type AgentLive } from './AgentState';
import { CH, CW } from '../screens/schema';
import { stageName } from './stage-name';
import { employeeKind, WorkerMark } from './WorkerMark';

export const STATUS_CLASS: Record<EmployeeStatus, string> = { working: 's-w', queued: 's-q', handed: 's-r', waiting: 's-h', idle: 's-i', off: 's-o' };

export const taskText = (e: Employee, t: ReturnType<typeof useT>) => {
  if (!e.task) return '';
  const route = e.task.echelons;
  const stage = route.ownerAgentId === e.id && route.stage ? `${stageName(t, route, route.stage)} ` : '';
  return `${stage}#${e.task.number} ${e.task.title}`;
};

export function modelLine(t: ReturnType<typeof useT>, e: Employee): string {
  /* Hornhoof names the level whenever it knows it, the Default's too; else it says the program picks it. */
  const effort = e.effort ? t.agent.effortLine(t.agent.efforts[e.effort] ?? e.effort) : e.provider && t.agent.effortDefault;
  return [e.modelName || e.model || t.agent.default, effort, e.provider && PROVIDER_NAMES[e.provider]].filter(Boolean).join(', ');
}

/* What an employee's third line says: its task, or why it has none. */
export function doingLine(t: ReturnType<typeof useT>, e: Employee): string {
  if (e.task) return taskText(e, t);
  if (!e.on) return t.dept.switchedOff;
  if (e.status === 'off') return t.dept.needsSubscription;
  if (e.timer && e.status === 'idle') return t.dept.onTimer(t.agent.every(e.timer));
  return e.status === 'idle' ? t.dept.waitsForTask : '';
}

export const agentWorking = ({ id, program, alarm, held, retry }: Employee): AgentLive => ({ id, program, alarm, held, retry });

export function Switch({ e, onSwitch }: { e: Employee; onSwitch?(on: boolean): void }) {
  const t = useT();
  if (!onSwitch) return null;
  return (
    <input
      type="checkbox"
      className="sw"
      checked={e.on}
      aria-label={t.dept.isOn(e.name)}
      title={t.dept.isOn(e.name)}
      onPointerDown={ev => ev.stopPropagation()}
      onChange={ev => onSwitch(ev.target.checked)}
    />
  );
}

/* lead: the employee leads a stage of a task now, and its chip is marked in its role's frame. An employee with no
   subscription yet is drawn grey, and its last line asks for one. The chip is CW wide and at least CH tall, taller when its
   words take more lines; what holds it lays out the height it measures. */
export const Chip = memo(function Chip({ e, x, y, on, lead = false, flash, serverNow, onOpen, onSwitch, row }: { e: Employee; x: number; y: number; on: boolean; lead?: boolean; flash: boolean; serverNow?: string; onOpen(event: MouseEvent<HTMLButtonElement>): void; onSwitch?(on: boolean): void; row?: string }) {
  const t = useT();
  return (
    <div className={`sslot dept-chip${e.on ? '' : ' off'}${e.on && e.status === 'off' ? ' no-plan' : ''}${onSwitch ? ' has-sw' : ''}`} data-row={row} style={{ left: x, top: y, width: CW, minHeight: CH }}>
      <button
        type="button"
        className={`schip ${STATUS_CLASS[e.status]}${on ? ' on' : ''}${lead ? ' lead' : ''}${flash ? ' flash' : ''}`}
        aria-pressed={on}
        onClick={onOpen}
      >
        <Edge cut={10} halo>
          <span className="r1">
            <WorkerMark kind={employeeKind(e.turnkey)} />
            <span className="mn">{e.name}</span>
            <ProviderMark provider={e.provider} />
            <span className="st" title={t.dept.status[e.status]}>{t.dept.status[e.status]}</span>
          </span>
          <span className="r2">{modelLine(t, e)}</span>
          <span className="r3">
            <AgentState agent={agentWorking(e)} serverNow={serverNow} />
            {doingLine(t, e)}
          </span>
          {e.context !== null && <Bar used={e.context} className="cx" title={t.dept.contextUsed(percent(e.context))} />}
        </Edge>
      </button>
      <Switch e={e} onSwitch={onSwitch} />
    </div>
  );
});
