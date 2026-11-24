#!/usr/bin/env node
/* A declared test service for the warm-services tests (#2091): it keeps its state in plain files of its folder, so a test
   reads what it did. start stays up until it is stopped; the rest end at once. */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [what, state, ...rest] = process.argv.slice(2);
const at = name => join(state, name);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const up = () => existsSync(at('up')) && alive(Number(readFileSync(at('up'), 'utf8')));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

switch (what) {
  case 'start': {
    mkdirSync(state, { recursive: true });
    appendFileSync(at('starts'), `${process.pid}\n`);
    /* A service that is down never answers: a test makes one by leaving this file. */
    if (existsSync(at('broken'))) { setInterval(() => {}, 1000); break; }
    const delay = existsSync(at('slow')) ? Number(readFileSync(at('slow'), 'utf8')) : 0;
    await wait(delay);
    writeFileSync(at('up'), String(process.pid));
    const stop = () => { rmSync(at('up'), { force: true }); process.exit(0); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    setInterval(() => {}, 1000);
    break;
  }
  case 'ready':
    process.exit(up() ? 0 : 1);
    break;
  case 'build': {
    const [digest] = rest;
    appendFileSync(at('builds'), `${digest}\n`);
    await wait(150);
    mkdirSync(at('templates'), { recursive: true });
    writeFileSync(join(at('templates'), digest), '');
    break;
  }
  case 'create': {
    const [digest, piece] = rest;
    if (!up()) { process.stderr.write('the service is down\n'); process.exit(3); }
    if (digest && !existsSync(join(at('templates'), digest))) { process.stderr.write(`no template ${digest}\n`); process.exit(4); }
    mkdirSync(join(at('pieces'), piece), { recursive: true });
    process.stdout.write(`FAKE_PIECE=${piece}\nFAKE_URL=fake://${piece}\n`);
    break;
  }
  case 'drop': {
    const [piece] = rest;
    if (existsSync(at('drop-fails'))) { process.stderr.write('cannot drop now\n'); process.exit(1); }
    appendFileSync(at('dropped'), `${piece}\n`);
    rmSync(join(at('pieces'), piece), { recursive: true, force: true });
    break;
  }
  case 'list':
    if (existsSync(at('pieces'))) for (const piece of readdirSync(at('pieces'))) process.stdout.write(`${piece}\n`);
    /* What another project keeps in the same service is never the node's to drop. */
    process.stdout.write('not_ours\n');
    break;
  default:
    process.stderr.write(`unknown ${what}\n`);
    process.exit(2);
}
