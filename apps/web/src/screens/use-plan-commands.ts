import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { api } from '../api';
import type { ShownCommand, SubView } from '../types';
import { toActiveCommand, type ActiveCommand } from '../ui/CommandBox';

type Setter<T> = Dispatch<SetStateAction<T>>;
type Controls = {
  subs: SubView[] | null; setSubs: Setter<SubView[] | null>; commands: ShownCommand[] | null;
  load: () => Promise<void>; connected: (shown: ActiveCommand, added: SubView[]) => void;
  newCommand: (sub: SubView) => Promise<void>; dismissCommand: (command: ShownCommand, id: string) => Promise<void>;
};

async function readPlans() {
  const [list, shown] = await Promise.all([
    api.get<{ subscriptions: SubView[] }>('/api/subscriptions'),
    api.get<{ commands: ShownCommand[] }>('/api/nodes/commands').then(
      r => ({ commands: r.commands, error: null }), error => ({ commands: null, error }),
    ),
  ]);
  return { subscriptions: list.subscriptions, ...shown };
}

const mergePlans = (old: SubView[] | null, added: SubView[]) => [...(old ?? []).filter(s => !added.some(a => a.id === s.id)), ...added];
const shownPlan = (shown: ActiveCommand, added: SubView[]): ShownCommand => ({
  ...shown, expiresAt: shown.expiresAt ?? '', kind: 'plans', subscriptionIds: added.map(s => s.id),
  dismissedSubscriptionIds: [], plans: added.map(s => s.label), machine: null,
});
const appendCommand = (old: ShownCommand[] | null, shown: ShownCommand) => [...(old ?? []), shown];
const dismiss = (all: ShownCommand[] | null, commandId: string, subId: string) =>
  all?.map(c => c.id === commandId ? { ...c, dismissedSubscriptionIds: [...(c.dismissedSubscriptionIds ?? []), subId] } : c) ?? null;

/* The list and its commands share a revision: a reply started before a local action cannot overwrite its result. */
export function usePlanCommands(live: { current: boolean }, setFailure: Setter<unknown>): Controls {
  const [subs, setSubs] = useState<SubView[] | null>(null);
  const [commands, setCommands] = useState<ShownCommand[] | null>(null);
  const revision = useRef(0);
  const load = useCallback(async () => {
    const started = revision.current;
    try {
      const next = await readPlans();
      if (!live.current || started !== revision.current) return;
      setSubs(next.subscriptions);
      if (next.commands) setCommands(next.commands);
      if (next.error) setFailure(next.error);
    } catch (err) {
      setFailure(err);
    }
  }, [live, setFailure]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const connected = (shown: ActiveCommand, added: SubView[]) => {
    revision.current++;
    setSubs(list => mergePlans(list, added));
    setCommands(list => appendCommand(list, shownPlan(shown, added)));
  };
  const newCommand = async (sub: SubView) => {
    const res = await api.post<{ id?: string; command: string; expiresAt?: string }>(`/api/subscriptions/${sub.id}/command`);
    connected(toActiveCommand(res), [sub]);
  };
  const dismissCommand = async (command: ShownCommand, id: string) => {
    await api.post(`/api/nodes/commands/${command.id}/hide`, { subscriptionId: id });
    revision.current++;
    setCommands(list => dismiss(list, command.id, id));
  };
  return { subs, setSubs, commands, load, connected, newCommand, dismissCommand };
}
