import type { LightMyRequestResponse } from 'fastify';
import { aclCompanyOn } from './agent-view-fixture.js';
import { listen, testApp } from './helpers.js';

/* A company for who sees which agent (#398): Development and Sales, Ann and Bob in its product App with a plan each,
   Olga who owns Development, Wes with the whole company and Lisa the CEO's delegate. Ann has one agent where she works and
   one in Sales, so own plan and reachable department each go alone. */
export async function aclCompany(env: NodeJS.ProcessEnv = {}) {
  const { app, db } = await testApp(env);
  return aclCompanyOn(app, db, await listen(app));
}

export type AclCompany = Awaited<ReturnType<typeof aclCompany>>;

/* What the response says, with none of the given agents, their names or their ids. */
export function leaks(res: Pick<LightMyRequestResponse, 'body'>, hidden: readonly { id: string; name: string }[]): string[] {
  const values: string[] = [], keys: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') values.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value)) { keys.push(key); visit(item); }
  };
  try { visit(JSON.parse(res.body)); } catch { values.push(res.body); }
  return hidden.flatMap(({ id, name }) => {
    const literal = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const word = new RegExp(`(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])`, 'u');
    return [...(values.concat(keys).some(value => value.includes(id)) ? [id] : []), ...(values.some(value => word.test(value)) ? [name] : [])];
  });
}
