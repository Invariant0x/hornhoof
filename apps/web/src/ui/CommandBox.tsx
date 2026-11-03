import type { Dispatch, SetStateAction } from 'react';
import { api } from '../api';
import { useLanguage, useT } from '../i18n';
import type { ShownCommand } from '../types';
import { CopyButton } from './CopyButton';
import { Edge } from './Edge';
import { clock } from './subscription';

export type ActiveCommand = { id: string; command: string; expiresAt: string | null };
export type CommandPanelState = { kind: 'connect' } | { kind: 'command'; shown: ActiveCommand } | null;

export const toActiveCommand = (res: { id?: string; command: string; expiresAt?: string | null }): ActiveCommand => ({
  id: res.id ?? '',
  command: res.command,
  expiresAt: res.expiresAt ?? null,
});

export const liveCommand = (cmd: ActiveCommand | null | undefined, now: number): ActiveCommand | null =>
  cmd && (!cmd.expiresAt || Date.parse(cmd.expiresAt) > now) ? cmd : null;

export const livePanel = (panel: CommandPanelState, now: number): CommandPanelState =>
  panel?.kind === 'command' && !liveCommand(panel.shown, now) ? null : panel;

export const openCommandIds = (cmds: Record<string, ActiveCommand>, now: number): string[] =>
  Object.keys(cmds).filter(id => Boolean(liveCommand(cmds[id], now)));

export const hideShownCommand = async (id: string): Promise<void> => {
  if (id) await api.post(`/api/nodes/commands/${id}/hide`);
};

const fetchShownCommands = () => api.get<{ commands: ShownCommand[] }>('/api/nodes/commands').catch(() => null);

const nextPlansPanel = (prev: CommandPanelState, found: ShownCommand | undefined): CommandPanelState =>
  found ? { kind: 'command', shown: toActiveCommand(found) } : prev?.kind === 'connect' ? prev : null;

export async function loadPlansCommand(live: { current: boolean }, setPanel: Dispatch<SetStateAction<CommandPanelState>>): Promise<void> {
  const res = await fetchShownCommands();
  if (!live.current || !res) return;
  const found = res.commands.findLast(c => c.kind === 'plans');
  setPanel(prev => nextPlansPanel(prev, found));
}

export async function loadMachineCommands(
  live: { current: boolean },
  setCommand: (cmd: ActiveCommand | null) => void,
  setAddCommands: (cmds: Record<string, ActiveCommand>) => void,
): Promise<void> {
  const res = await fetchShownCommands();
  if (!live.current || !res) return;
  const found = res.commands.findLast(c => c.kind === 'machine');
  setCommand(found ? toActiveCommand(found) : null);
  const adds: Record<string, ActiveCommand> = {};
  for (const c of res.commands) {
    if (c.kind === 'add' && c.machineId) adds[c.machineId] = toActiveCommand(c);
  }
  setAddCommands(adds);
}

/* The install command with Copy, and what running it means for the person's subscription, or for their machine. */
export function CommandBox({ command, trust }: { command: string; trust?: string }) {
  const t = useT();
  return (
    <div className="command-box">
      <div className="command">
        <code>{command}</code>
        <CopyButton text={command} />
      </div>
      <p className="trust">{trust ?? t.subs.trust}</p>
    </div>
  );
}

/* Until when a one-time command works, or 24 hours when its clock time is not given. */
export function CommandLifetime({ expiresAt }: { expiresAt?: string | null }) {
  const t = useT();
  const { language } = useLanguage();
  const at = clock(language, expiresAt ?? null);
  return <p className="muted">{at ? t.subs.joinUntil(at) : t.subs.joinOnce}</p>;
}

export function ActiveCommandPanel({
  heading,
  run,
  trust,
  shown,
  onCancel,
}: {
  heading: string;
  run: string;
  trust?: string;
  shown: ActiveCommand;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <Edge className="panel" cut={12}>
      <h2>{heading}</h2>
      <p className="muted">{run}</p>
      <CommandBox command={shown.command} trust={trust} />
      <CommandLifetime expiresAt={shown.expiresAt} />
      <div className="actions">
        <button className="btn ghost" type="button" onClick={onCancel}>
          {t.subs.cancelCommand}
        </button>
      </div>
    </Edge>
  );
}
