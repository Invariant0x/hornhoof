import type { Db } from '../../db/client.js';
import { queryOf } from '../merge/leader.js';

/* A replication slot of the server's Postgres. pid: the connection that reads it now, none while nobody does.
   confirmed: how far its reader said it holds the changes. */
export type CopySlot = { name: string; pid: number | null; walStatus: string | null; confirmed: string | null };

/* What the app asks of its Postgres about the copies that follow it. */
export type Replication = {
  slots(): Promise<CopySlot[]>;
  /* Ends the connection that reads a slot. */
  end(pid: number): Promise<void>;
  /* Throws while a connection still reads it. */
  drop(name: string): Promise<void>;
};

export function replicationOf(db: Db): Replication {
  const q = queryOf(db);
  return {
    slots: () => q<CopySlot>('SELECT slot_name::text AS name, active_pid AS pid, wal_status AS "walStatus", confirmed_flush_lsn::text AS confirmed FROM pg_replication_slots ORDER BY slot_name'),
    end: async pid => void (await q('SELECT pg_terminate_backend($1::int)', [pid])),
    drop: async name => void (await q('SELECT pg_drop_replication_slot($1::text)', [name])),
  };
}

/* What every slot of a machine's copy starts with, whatever the attempt: the first 16 hex characters of its network id. */
export const slotPrefix = (networkId: string): string => `copy_${networkId.slice(0, 16).toLowerCase()}_`;
