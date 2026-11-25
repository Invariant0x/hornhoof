import type { NodeLoad } from '@hornhoof/protocol';
import type { BuiltinView, ComputerAccessView, MachineView, Running, SubView } from '../types';

export type MachineRow = Omit<MachineView, 'owner' | 'lendsTests'> & {
  owner: MachineView['owner'] | null;
  lendsTests: boolean | null;
  server: boolean;
  source: MachineView | null;
  /* Where the company opens on this machine: its core's port, or the server's own on the server's card. */
  openAt: number | null;
  /* On the server's card: the machines whose connections the server did not take. */
  refusedBy: string[];
  /* The computer access of the machine the card stands for: the server's own on the server's card. */
  access: ComputerAccessView | null;
};

/* The server merges work in map order; older responses still keep built-in work apart. */
function combinedRunning(machine: Running, builtin: Running): Running {
  const agents = new Map([...machine.agents, ...builtin.agents].map(a => [a.id, a]));
  const parts = new Map([...machine.parts, ...builtin.parts].map(p => [`${p.kind}-${p.run}-${p.part}`, p]));
  return { agents: [...agents.values()], parts: [...parts.values()] };
}

function machineConnection(machine: MachineView, builtin: BuiltinView | null) {
  const copyNames = { ...(builtin?.copyNames ?? {}), ...(machine.copyNames ?? {}) };
  return {
    online: machine.online || Boolean(builtin?.online),
    load: machine.load ?? builtin?.load ?? null,
    replicas: machine.replicas ?? builtin?.replicas ?? null,
    ...(Object.keys(copyNames).length ? { copyNames } : {}),
  };
}

function machineNotes(machine: MachineView, builtin: BuiltinView | null) {
  return {
    checkError: machine.checkError || builtin?.checkError || null,
    browserError: machine.browserError || builtin?.browserError || null,
    drain: machine.drain ?? builtin?.drain ?? null,
  };
}

function joinedMachineRow(machine: MachineView, builtin: BuiltinView | null, keys: MachineView['plans']): MachineRow {
  return {
    ...machine, source: machine, server: Boolean(builtin),
    openAt: builtin?.webPort ?? machine.core?.webPort ?? null,
    refusedBy: builtin?.refusedBy ?? [],
    access: builtin?.access ?? machine.access ?? null,
    ...machineConnection(machine, builtin),
    ...machineNotes(machine, builtin),
    plans: [...machine.plans, ...(builtin ? keys : [])],
    running: builtin ? combinedRunning(machine.running, builtin.running) : machine.running,
  };
}

export function machineRows(machines: MachineView[], builtin: BuiltinView | null, subs: SubView[], builtinName: string): MachineRow[] {
  const host = builtin?.machine?.id;
  const keys = subs.filter(s => s.kind === 'api_key').map(s => ({ id: s.id, provider: s.provider, status: s.status === 'needs_login' ? 'needs_login' as const : 'ready' as const, online: s.online }));
  const rows = machines.map(m => joinedMachineRow(m, m.id === host ? builtin : null, keys));
  if (!builtin || machines.some(m => m.id === host)) return rows;
  return [...rows, { id: 'builtin', hostname: builtinName, source: null, server: true, openAt: builtin.webPort ?? null, refusedBy: builtin.refusedBy ?? [], access: builtin.access ?? null, owner: null, lendsTests: null, os: 'linux', arch: '', online: builtin.online, lastSeenAt: null, plans: keys, load: builtin.load, ...(builtin.copyNames ? { copyNames: builtin.copyNames } : {}), replicas: builtin.replicas, running: builtin.running, programs: builtin.programs, browserError: builtin.browserError || null, checkError: builtin.checkError || null, drain: builtin.drain ?? null, fileStore: builtin.fileStore ?? null }];
}

function poolLoads(machines: MachineView[], host: MachineView | null, builtin: BuiltinView | null, apart: BuiltinView | null): NodeLoad[] {
  return [...machines.map(m => (m === host ? (m.load ?? builtin!.load) : m.load)), apart?.load ?? null].filter((l): l is NodeLoad => l !== null);
}

function poolOnline(machines: MachineView[], host: MachineView | null, builtin: BuiltinView | null, apart: BuiltinView | null): number {
  return machines.filter(m => m.online || (m === host && builtin!.online)).length + (apart?.online ? 1 : 0);
}

/* The built-in node on a machine that joined runs on that machine's computer, which the pool counts once and the list
   shows as one card: online while either is, with what either says it has and what runs on either. */
export function machinePool(machines: MachineView[], builtin: BuiltinView | null): { loads: NodeLoad[]; online: number; all: number } {
  const host = builtin?.machine ? (machines.find(m => m.id === builtin.machine!.id) ?? null) : null;
  const apart = host ? null : builtin;
  return { loads: poolLoads(machines, host, builtin, apart), online: poolOnline(machines, host, builtin, apart), all: machines.length + (apart ? 1 : 0) };
}

export function addablePlans(machine: MachineView | null, subs: SubView[], personId: string): SubView[] {
  if (!machine || machine.owner.id !== personId) return [];
  return subs.filter(s => s.kind === 'personal' && s.owner.id === personId && !machine.plans.some(p => p.id === s.id));
}
