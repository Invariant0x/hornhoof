import type { LabMachine } from './lab.js';
import type { Written } from './overlap.js';
import { http, literal, pause, quoted } from './steps.js';

/* Where the writer makes its next task: a machine of the lab, the address the company answers at on it, and what the
   request carries besides that machine's own session. */
export type Door = { machine: LabMachine; url: string; headers?: Record<string, string> };

/* Someone who works in the company the whole scenario long: a new task every so often through the company's API, at
   the door that is asked for before each one, and none while there is no door. It keeps each task the company
   confirmed, and no other, with when the answer came and which machine gave it: what was confirmed must be on every
   machine that holds the data, whatever happened meanwhile. A request that is held gives up after ten seconds. */
export function startWriterAt(door: () => Promise<Door | null>, everyMs = 200): { written(): Written[]; stop(): Promise<Written[]> } {
  const kept: Written[] = [];
  let going = true;
  const loop = (async () => {
    for (let n = 1; going; n++) {
      const at = await door().catch(() => null);
      const made = at && (await http(at.machine, 'POST', `${at.url}/api/tasks`, { body: { title: `Written ${n}` }, headers: at.headers, maxTime: 10 }).catch(() => null));
      if (at && made && made.status >= 200 && made.status < 300) {
        try {
          const id = made.json<{ task?: { id?: string } }>().task?.id;
          if (id) kept.push({ id, at: Date.now(), machine: at.machine.name });
        } catch {
          /* An answer that is no task confirmed nothing. */
        }
      }
      await pause(everyMs);
    }
  })();
  return {
    written: () => [...kept],
    stop: async () => {
      going = false;
      await loop;
      return [...kept];
    },
  };
}

/* The same at one machine's address, with the session that machine holds; the ids of what it kept. */
export function startWriter(machine: LabMachine, url: string, everyMs = 500): { ids(): string[]; stop(): Promise<string[]> } {
  const writer = startWriterAt(async () => ({ machine, url }), everyMs);
  return { ids: () => writer.written().map(one => one.id), stop: async () => (await writer.stop()).map(one => one.id) };
}

/* The ids that are missing from the tasks of a machine's own database, asked in the compose folder it runs from. */
export async function checkRows(machine: LabMachine, folder: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const query = `SELECT coalesce(string_agg(want.id, ','), '') FROM unnest(ARRAY[${ids.map(literal).join(',')}]::text[]) AS want(id) WHERE NOT EXISTS (SELECT FROM tasks t WHERE t.id::text = want.id)`;
  const ran = await machine.exec(`cd ${folder} && docker compose exec -T db psql -U hornhoof -d hornhoof -tA`, { input: query });
  if (ran.code !== 0) throw new Error(`Could not ask ${machine.name} for its tasks: ${ran.out.slice(-1000)}`);
  return ran.out.trim().split(',').filter(Boolean);
}

/* One question to the database a machine keeps, in the compose folder it runs from. */
export async function sqlIn(machine: LabMachine, folder: string, query: string, database = 'hornhoof'): Promise<string> {
  const ran = await machine.exec(`cd ${folder} && docker compose exec -T db psql -U hornhoof -d ${database} -tAc ${quoted(query)}`);
  if (ran.code !== 0) throw new Error(`psql on ${machine.name} ended with ${ran.code}: ${ran.out.slice(-1000)}`);
  return ran.out.trim();
}
