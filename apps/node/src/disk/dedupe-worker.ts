import { readFileSync } from 'node:fs';
import { dedupeNodeModules, pruneCas, type DedupeOptions, type PruneOptions } from './dedupe.js';

type WorkerRequest = Omit<DedupeOptions, 'link'> & { prune?: PruneOptions };

/* Short-lived unprivileged worker spawned by runDedupeForOwner when the node process runs as root, so hard-link
   deduplication and CAS pruning never touch agent workspaces as root. */
const raw = readFileSync(0, 'utf8');
const req = JSON.parse(raw) as WorkerRequest;
const dedup = dedupeNodeModules(req);
const gc = req.prune ? pruneCas(req.store, req.prune) : { pruned: 0, freed: 0 };
process.stdout.write(JSON.stringify({ ...dedup, gcPruned: gc.pruned, gcFreed: gc.freed }) + '\n');
