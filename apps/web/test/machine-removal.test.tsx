import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { MachineView, RemovalWarnings } from '../src/types';
import { canRemoveMachine, removalWarningLines } from '../src/ui/machine-removal';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const MACHINE: Pick<MachineView, 'plans'> = { plans: [] };
const CLEAR: RemovalWarnings = { lastReplica: false, onlyBackup: false, uncollectedData: false, kept: null, keptAt: null };

function rendered(lines: ReturnType<typeof removalWarningLines>) {
  const { container } = render(<div>{lines.map((line, i) => <p key={i}>{line}</p>)}</div>);
  return {
    container,
    paragraphs: [...container.querySelectorAll('p')].map(p => p.textContent ?? ''),
  };
}

describe('canRemoveMachine', () => {
  const source = { id: 'm1' } as MachineView;

  it('allows removing any non-leader machine when editable, including a former server, and never the leader', () => {
    expect(canRemoveMachine({ server: false, source }, true)).toBe(true);
    expect(canRemoveMachine({ server: false, source: { ...source, serverInstall: true } }, true)).toBe(true);
    expect(canRemoveMachine({ server: true, source }, true)).toBe(false);
    expect(canRemoveMachine({ server: true, source: null }, true)).toBe(false);
    expect(canRemoveMachine({ server: false, source }, false)).toBe(false);
  });
});

describe('removalWarningLines', () => {
  it('shows last replica, only backup, uncollected data, general local-work warning when offline, and Claude sign-in note', () => {
    const { paragraphs } = rendered(removalWarningLines(
      en,
      'en',
      { plans: [{ id: 'p1', provider: 'claude', status: 'ready', online: true }] },
      { lastReplica: true, onlyBackup: true, uncollectedData: true, kept: null, keptAt: null },
    ));
    expect(paragraphs).toEqual([
      en.machines.removal.lastReplica,
      en.machines.removal.onlyBackup,
      en.machines.removal.uncollectedData,
      en.machines.removal.localWorkUnknown,
      en.machines.disconnectClaude,
    ]);
  });

  it('lists exact kept entries with <bdi> isolation, task, size, all three reasons, ignored paths, masked private assistant, and timestamp in English and Russian', () => {
    const warnings: RemovalWarnings = {
      ...CLEAR,
      keptAt: '2026-11-21T09:15:00.000Z',
      kept: [
        { agent: 'a1', agentName: 'Casey', path: 'repo-task-42', task: 42, bytes: 2.5 * GIB, why: 'uncommitted' },
        { agent: 'scratch-box', agentName: null, path: 'draft-branch', task: null, bytes: 12 * MIB, why: 'unpushed' },
        { agent: 'a2', agentName: 'Morgan', path: 'app-copy', task: 91, bytes: 512 * 1024, why: 'ignored', ignored: ['.env', 'local/data.db'] },
        { agent: null, agentName: null, path: null, task: null, bytes: 2 * GIB, why: 'uncommitted' },
      ],
    };

    const enOut = rendered(removalWarningLines(en, 'en', MACHINE, warnings));
    expect(enOut.paragraphs[0]).toMatch(/^Work on this machine that cannot be restored \(checked .+\):$/);
    expect(enOut.paragraphs[1]).toBe('Casey, repo-task-42: task #42, 2.5 GB, changes not committed');
    expect(enOut.paragraphs[2]).toBe('scratch-box, draft-branch: 12 MB, commits not pushed');
    expect(enOut.paragraphs[3]).toBe('Morgan, app-copy: task #91, 512 KB, ignored files not on a remote: .env, local/data.db');
    expect(enOut.paragraphs[4]).toBe("Another person's private assistant: 2 GB, changes not committed");
    expect(enOut.paragraphs[5]).toBe(en.machines.removal.keptActiveNote);
    /* Names, paths and ignored filenames are each isolated in <bdi> for RTL safety, with no nested block tags inside <p>. */
    expect([...enOut.container.querySelectorAll('bdi')].map(el => el.textContent)).toEqual([
      'Casey', 'repo-task-42', 'scratch-box', 'draft-branch', 'Morgan', 'app-copy', '.env', 'local/data.db',
    ]);
    expect(enOut.container.querySelectorAll('p ul, p div, p p')).toHaveLength(0);

    const ruOut = rendered(removalWarningLines(ru, 'ru', MACHINE, warnings));
    expect(ruOut.paragraphs[0]).toMatch(/^Работа на этой машине, которую нельзя восстановить \(проверено .+\):$/);
    expect(ruOut.paragraphs[1]).toContain('Casey, repo-task-42: задача #42,');
    expect(ruOut.paragraphs[1]).toContain('изменения не закоммичены');
    expect(ruOut.paragraphs[3]).toContain('игнорируемые файлы без копии в репозитории: .env, local/data.db');
    expect(ruOut.paragraphs[4]).toContain('Личный помощник другого человека:');
    expect(ruOut.paragraphs[5]).toBe(ru.machines.removal.keptActiveNote);
  });

  it('distinguishes an empty measured kept report from an unmeasured offline machine', () => {
    const empty = rendered(removalWarningLines(en, 'en', MACHINE, { ...CLEAR, kept: [], keptAt: '2026-11-21T09:15:00.000Z' }));
    expect(empty.paragraphs).toHaveLength(1);
    expect(empty.paragraphs[0]).toMatch(/^No unsaved work from finished tasks was found at .+\. Check active tasks before deleting files on this machine\.$/);

    const offline = rendered(removalWarningLines(en, 'en', MACHINE, CLEAR));
    expect(offline.paragraphs).toEqual([en.machines.removal.localWorkUnknown]);
  });
});
