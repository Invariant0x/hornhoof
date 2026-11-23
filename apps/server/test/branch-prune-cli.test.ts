import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { archiveRef } from '../src/modules/repos/prune-run.js';
import { prepareSharedDatabase } from './helpers-db.js';
import { prepareTemplates } from './templates-once.js';
import { company, M1, T1, U1, U2, withTask, type Fixture } from './prune-fixture.js';

await prepareSharedDatabase();
prepareTemplates();

/* #1964: the one-time cleanup and any later one run by the command `branch-prune`: a dry run unless it is told to apply. */
async function cli(f: Fixture, args: string[]) {
  const lines: string[] = [];
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const { readBranches, readTags, readMerged, pushRefs } = f.ctx;
  const code = await runCli(['branch-prune', ...args], { db: f.db, config: f.ctx.config, print: line => lines.push(line), prune: { readBranches, readTags, readMerged, pushRefs, log } });
  return { code, out: lines.join('\n'), lines };
}

async function repository() {
  const f = await company();
  const held = await withTask(f, 'In the turn', { status: 'done', closedDaysAgo: 1 });
  const cancelled = await withTask(f, 'Cancelled', { status: 'cancelled', closedDaysAgo: 1 });
  const open = await withTask(f, 'Open', {});
  Object.assign(f.repo.heads, { [`task-${held}`]: T1, [`task-${cancelled}`]: U1, [`task-${open}`]: U2, 'feature/mine': M1 });
  return { f, held, cancelled, open };
}

describe('the branch-prune command', () => {
  it('is a dry run unless it is told to apply: it lists what it would do with each branch and the counts, and changes nothing', async () => {
    const { f, held, cancelled, open } = await repository();
    const before = { ...f.repo.heads };
    const { code, out, lines } = await cli(f, []);
    expect(code).toBe(0);
    expect(f.pushed).toEqual([]);
    expect(f.repo.heads).toEqual(before);
    expect(lines).toContain(['https://github.com/acme/shop.git', `task-${held}`, T1, 'delete', 'held', `its work is in ${f.branch}`].join('\t'));
    expect(lines).toContain(['https://github.com/acme/shop.git', `task-${cancelled}`, U1, 'archive', 'archive', `its task is cancelled and no turn, main or tag holds its work`].join('\t'));
    expect(out).not.toContain(`task-${open}\t`);
    expect(out).not.toContain('feature/mine');
    expect(out).toMatch(/# https:\/\/github\.com\/acme\/shop\.git: \d+ branches, dry run: 1 to delete, 1 to archive/);
    expect(out).toContain('held 1');
    expect(out).toContain('foreign 1');
  });

  it('lists the branches it keeps as well with --all-branches', async () => {
    const { f, open } = await repository();
    const { out } = await cli(f, ['--all-branches']);
    expect(out).toContain(`\ttask-${open}\t${U2}\tkeep\tlive\t`);
    expect(out).toContain('\tfeature/mine\t');
  });

  it('applies only with --apply: deletes and archives, and says how many branches there were before and are after, and how to restore', async () => {
    const { f, held, cancelled, open } = await repository();
    const { code, out } = await cli(f, ['--apply']);
    expect(code).toBe(0);
    expect(Object.keys(f.repo.heads)).not.toContain(`task-${held}`);
    expect(Object.keys(f.repo.heads)).not.toContain(`task-${cancelled}`);
    expect(f.repo.heads[`task-${open}`]).toBe(U2);
    expect(f.archived).toEqual({ [archiveRef(`task-${cancelled}`)]: U1 });
    expect(out).toMatch(/applied: 1 deleted, 1 archived, 0 refused; branches before 6, after 4/);
    expect(out).toContain(`git fetch origin ${archiveRef(`task-${cancelled}`)} && git push origin FETCH_HEAD:refs/heads/task-${cancelled}`);
  });

  it('does at most --limit changes a repository, and says there is more', async () => {
    const { f } = await repository();
    const { out } = await cli(f, ['--apply', '--limit', '1']);
    expect(out).toMatch(/applied: 1 deleted, 0 archived, 0 refused/);
    expect(out).toContain('more to do: run it again');
  });

  it('limits itself to the repositories whose address has the text given, and to a company', async () => {
    const { f } = await repository();
    const none = await cli(f, ['--repo', 'nothing-like-it']);
    expect(none.out).toContain('no repository matches');
    expect(none.code).toBe(1);
    const some = await cli(f, ['--repo', 'ACME/shop']);
    expect(some.out).toContain('shop.git');
    const wrong = await cli(f, ['--company', '00000000-0000-4000-8000-000000000000']);
    expect(wrong.code).toBe(1);
  });

  it('refuses an option it does not know and a number that is none, before it reads anything', async () => {
    const { f } = await repository();
    for (const args of [['--delete'], ['--limit', 'many'], ['--limit', '0'], ['--budget', '-1'], ['--limit'], ['--company', 'not-an-id'], ['extra']]) {
      const { code, out } = await cli(f, args);
      expect(code, args.join(' ')).toBe(1);
      expect(out, args.join(' ')).toContain('Usage: node apps/server/dist/cli.js branch-prune');
    }
    expect(f.pushed).toEqual([]);
  });

  it('says a repository it could not read, and goes on with the next', async () => {
    const { f } = await repository();
    const real = f.ctx.readBranches!;
    f.ctx.readBranches = async (repo, timeout) => (repo.url.includes('shop') ? { problem: 'Hornhoof could not read the branches of the repository: it answered 502.' } : real(repo, timeout));
    const { out, code } = await cli(f, ['--apply']);
    expect(code).toBe(1);
    expect(out).toContain('left as it is: Hornhoof could not read the branches');
    expect(f.pushed).toEqual([]);
  });
});
