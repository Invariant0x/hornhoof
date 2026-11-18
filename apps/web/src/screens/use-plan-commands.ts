import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { api } from '../api';
import type { ShownCommand, SubView } from '../types';
import { toActiveCommand, type ActiveCommand } from '../ui/CommandBox';
import { everyVisible } from '../guard';
import { latestAnswers, useStream } from '../live';

type Setter<T> = Dispatch<SetStateAction<T>>;
type Controls = {
  failure: unknown; commandsFailure: unknown;
  subs: SubView[] | null; setSubs: Setter<SubView[] | null>; commands: ShownCommand[] | null;
  /* Where this person connects an API key: anywhere (null), or only in these departments, which they run. */
  apiPlaces: string[] | null;
  load: () => Promise<void>; connected: (shown: ActiveCommand, added: SubView[]) => void;
  newCommand: (sub: SubView) => Promise<void>; dismissCommand: (command: ShownCommand, id: string) => Promise<void>;
};

async function readPlans() {
  const [list, shown] = await Promise.all([
    api.get<{ subscriptions: SubView[]; apiPlaces?: string[] | null }>('/api/subscriptions'),
    api.get<{ commands: ShownCommand[] }>('/api/nodes/commands').then(
      r => ({ commands: r.commands, error: null }), error => ({ commands: null, error }),
    ),
  ]);
  return { subscriptions: list.subscriptions, apiPlaces: list.apiPlaces === undefined ? [] : list.apiPlaces, ...shown };
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
export function usePlanCommands(live: { current: boolean }): Controls {
  const [readFailure, setReadFailure] = useState<{ plans: unknown; commands: unknown }>({ plans: null, commands: null });
  const [subs, setSubs] = useState<SubView[] | null>(null);
  const [apiPlaces, setApiPlaces] = useState<string[] | null>([]);
  const [commands, setCommands] = useState<ShownCommand[] | null>(null);
  const revision = useRef(0);
  const [askPlans] = useState(latestAnswers);
  const load = useCallback(async () => {
    const started = revision.current;
    const fresh = askPlans();
    const wanted = () => live.current && started === revision.current && fresh();
    try {
      const next = await readPlans();
      if (!wanted()) return;
      setSubs(next.subscriptions);
      setApiPlaces(next.apiPlaces);
      setReadFailure({ plans: null, commands: next.error });
      if (next.commands) setCommands(next.commands);
    } catch (err) {
      if (wanted()) setReadFailure({ plans: err, commands: null });
    }
  }, [askPlans, live]);
  useEffect(() => {
    void load();
    return everyVisible(() => void load(), 5000);
  }, [load]);
  /* After a break, an update among them, the plans are read again at once. */
  useStream(m => {
    if (m.type === 'reconnected') void load();
  });

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
  return { subs, setSubs, apiPlaces, commands, load, connected, newCommand, dismissCommand, failure: readFailure.plans, commandsFailure: readFailure.commands };
}
