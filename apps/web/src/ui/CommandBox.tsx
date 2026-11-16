import { useEffect, useId, useState } from 'react';
import { api } from '../api';
import { useT, type Messages } from '../i18n';
import { withOwnerKey } from '../owner-key';
import type { ShownCommand } from '../types';
import { CopyButton } from './CopyButton';
import { Edge } from './Edge';
import { NO_KEY_HERE, useOwnerKey } from './PasswordPrompt';
import { useNow } from './reset';

export type ActiveCommand = { id: string; command: string; expiresAt: string | null };

export const toActiveCommand = (res: { id?: string; command: string; expiresAt?: string | null }): ActiveCommand => ({
  id: res.id ?? '',
  command: res.command,
  expiresAt: res.expiresAt ?? null,
});

export const liveCommand = (cmd: ActiveCommand | null | undefined, now: number): ActiveCommand | null =>
  cmd && (!cmd.expiresAt || Date.parse(cmd.expiresAt) > now) ? cmd : null;

export const openCommandIds = (cmds: Record<string, ActiveCommand>, now: number): string[] =>
  Object.keys(cmds).filter(id => Boolean(liveCommand(cmds[id], now)));

export const hideShownCommand = async (id: string): Promise<void> => {
  if (id) await api.post(`/api/nodes/commands/${id}/hide`);
};

const fetchShownCommands = () => api.get<{ commands: ShownCommand[] }>('/api/nodes/commands').catch(() => null);

export async function loadMachineCommands(
  live: { current: boolean },
  setCommand: (cmd: ActiveCommand | null) => void,
  setAddCommands: (cmds: Record<string, ActiveCommand>) => void,
  setCoreCommands: (cmds: Record<string, ActiveCommand>) => void = () => undefined,
): Promise<void> {
  const res = await fetchShownCommands();
  if (!live.current || !res) return;
  const found = res.commands.findLast(c => c.kind === 'machine');
  setCommand(found ? toActiveCommand(found) : null);
  const adds: Record<string, ActiveCommand> = {};
  const cores: Record<string, ActiveCommand> = {};
  for (const c of res.commands) {
    if (c.kind === 'add' && c.machineId) adds[c.machineId] = toActiveCommand(c);
    if (c.kind === 'core' && c.machineId) cores[c.machineId] = toActiveCommand(c);
  }
  setAddCommands(adds);
  setCoreCommands(cores);
}

/* The install command the server gave, for Windows PowerShell: it runs install.ps1 of the same server with the same words,
   which runs the same install.sh in Docker Desktop. It is made here from the command, so the code in it, and the owner's
   key a joining command carries, reach exactly the screens the command reaches. None for a command of another kind. */
export function windowsCommand(command: string): string | null {
  const m = /^curl -fsSL (https?:\/\/[^\s"'`$;|&]+)\/install\.sh \| bash(?: -s -- (--join [A-Za-z0-9_-]+(?: --owner-key [A-Za-z0-9_-]{80,200})?))?$/.exec(command);
  if (!m) return null;
  const script = `${m[1]}/install.ps1`;
  return m[2]
    ? `powershell -ExecutionPolicy Bypass -c "& ([scriptblock]::Create((irm ${script}))) ${m[2]}"`
    : `powershell -ExecutionPolicy Bypass -c "irm ${script} | iex"`;
}

function CommandLine({ command, label }: { command: string; label?: string }) {
  const id = useId();
  const line = (
    <div className="command">
      <code>{command}</code>
      <CopyButton text={command} />
    </div>
  );
  if (!label) return line;
  return (
    <div className="command-box" role="group" aria-labelledby={id}>
      <p className="muted" id={id}>{label}</p>
      {line}
    </div>
  );
}

/* The install command with Copy, the same one for Windows beside it when there is one, and what running it means for
   the person's subscription, or for their machine. A command that joins a machine shows with the viewer's own key on it, so the machine knows its owner: with no key yet
   it is made first, with the password the screen holds or else asked for. Only where the browser can make no key does
   the command show without one, with a line that says so: such a machine joins and opens to nobody. Any other command
   shows as it is. */
export function CommandBox({ command, trust, password }: { command: string; trust?: string; password?: string }) {
  const t = useT();
  const joins = command.includes(' --join ');
  const { publicKey, prompt } = useOwnerKey();
  const [key, setKey] = useState<string | null>(null);
  const [left, setLeft] = useState(false);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    if (!joins) return;
    let live = true;
    setLeft(false);
    /* The screen's own password is for the first try: one that did not work is asked for after it. */
    publicKey(tries === 0 ? password : undefined).then(
      found => {
        if (!live) return;
        setKey(found);
        setLeft(found === null);
      },
      () => live && setLeft(true),
    );
    return () => {
      live = false;
    };
  }, [joins, tries, password, publicKey]);

  const keyless = joins && key === NO_KEY_HERE;
  const shown = joins && !keyless ? (key ? withOwnerKey(command, key) : null) : command;
  const windows = shown ? windowsCommand(shown) : null;
  return (
    <div className="command-box">
      {shown ? (
        <>
          <CommandLine command={shown} label={windows ? t.subs.onMacLinux : undefined} />
          {windows && <CommandLine command={windows} label={t.subs.onWindows} />}
        </>
      ) : left ? (
        <>
          <p className="muted">{t.subs.ownerKeyNeeded}</p>
          <div className="actions">
            <button className="btn" type="button" onClick={() => setTries(n => n + 1)}>{t.subs.ownerKeyEnter}</button>
          </div>
        </>
      ) : (
        prompt ?? <p className="muted">{t.subs.ownerKeyMaking}</p>
      )}
      {keyless && <p className="muted">{t.subs.ownerKeyNotHere}</p>}
      {/* The stripe and the lines start where the page does; the words read whole in their own direction. */}
      <p className="trust"><bdi>{trust ?? t.subs.trust}</bdi></p>
    </div>
  );
}

/* Remaining time is shared by the top block, the plan's card and machine commands. */
function commandDuration(t: Messages, expiresAt: string | null | undefined, now: number): string {
  if (!expiresAt) return t.subs.joinOnce;
  const minutes = Math.max(1, Math.floor((Date.parse(expiresAt) - now) / 60_000));
  if (minutes >= 60) return t.subs.commandHours(Math.floor(minutes / 60));
  return t.subs.commandMinutes(minutes);
}

export function CommandLifetime({ expiresAt }: { expiresAt?: string | null }) {
  const t = useT();
  const now = useNow();
  return <><p className="muted">{commandDuration(t, expiresAt, now)}</p>{expiresAt && <p className="muted">{t.subs.commandBackground}</p>}</>;
}

export const commandBlockOpen = (cmd: ShownCommand): boolean =>
  cmd.kind !== 'plans' || !cmd.subscriptionIds?.length || cmd.subscriptionIds.some(id => !cmd.dismissedSubscriptionIds?.includes(id));

export function ActiveCommandPanel({
  heading,
  run,
  note,
  trust,
  shown,
  onCancel,
}: {
  heading: string;
  run: string;
  /* What else the person should know before they run it. */
  note?: string;
  trust?: string;
  shown: ActiveCommand;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <Edge className="panel" cut={12}>
      <h2>{heading}</h2>
      <p className="muted">{run}</p>
      {note && <p className="muted">{note}</p>}
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
