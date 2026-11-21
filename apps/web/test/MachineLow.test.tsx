import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import type { MachineLowCard } from '../src/types';
import { MachineLow } from '../src/ui/MachineLow';

const GIB = 1024 ** 3;
/* A made-up machine of Lisa's: 40 GB free of 500, under the 50 GB it needs, after cleaning 8 GB of check files and 3 GB of
   build cache, and 1 GB more of check files before that. */
const LOW: MachineLowCard = {
  id: 'm1',
  hostname: 'studio-laptop',
  owner: { id: 'p1', name: 'Lisa' },
  since: '2026-11-20T10:00:00.000Z',
  disk: {
    total: 500 * GIB,
    free: 40 * GIB,
    threshold: 50 * GIB,
    parts: { images: 60 * GIB, volumes: 30 * GIB, buildCache: 20 * GIB, workingCopies: 120 * GIB, checkTemp: 5 * GIB },
    low: { since: '2026-11-20T10:00:00.000Z' },
    cleaned: [
      { part: 'checkTemp', bytes: 8 * GIB, at: '2026-11-20T09:59:00.000Z' },
      { part: 'buildCache', bytes: 3 * GIB, at: '2026-11-20T09:58:00.000Z' },
      { part: 'checkTemp', bytes: 1 * GIB, at: '2026-11-20T09:30:00.000Z' },
    ],
  },
  names: {},
};
/* Work the machine keeps because it can't be restored: Theo's copy with changes not committed, and one of a folder no
   employee of the company has. */
const THEO = '00000000-0000-4000-8000-0000000000a1';
const STRAY = '00000000-0000-4000-8000-0000000000b2';
const KEEPS: MachineLowCard = {
  ...LOW,
  names: { [THEO]: 'Theo' },
  disk: {
    ...LOW.disk,
    kept: [
      { part: 'workingCopies', agent: STRAY, path: 'scratch/copy', task: null, bytes: 2.5 * GIB, why: 'unpushed' },
      { part: 'workingCopies', agent: THEO, path: 'hornhoof-1750', task: 1750, bytes: 9 * GIB, why: 'uncommitted' },
    ],
  },
};

const shown = (machines: MachineLowCard[]) => render(<LanguageProvider><MachineLow machines={machines} /></LanguageProvider>);

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('a machine short of disk space, as its people read it', () => {
  it('says which and whose, the free space it has and needs, what Hornhoof takes, what it cleaned, what goes on and what to do', () => {
    shown([LOW]);
    const card = screen.getByRole('region', { name: 'Machine studio-laptop (Lisa) is low on disk space' });
    expect(within(card).getByText('Free: 40 GB of 500 GB. It needs at least 50 GB.')).toBeInTheDocument();
    expect(within(card).getByText('Hornhoof takes: working copies 120 GB, images 60 GB, volumes 30 GB, build cache 20 GB, check temp files 5 GB.')).toBeInTheDocument();
    expect(within(card).getByText('Removed in the last 24 hours: check temp files 9 GB, build cache 3 GB.')).toBeInTheDocument();
    expect(within(card).queryByText(/^Docker's own disk/)).not.toBeInTheDocument();
    expect(within(card).getByText('It keeps running its turns, but takes no new checks or builds until space is back.')).toBeInTheDocument();
    expect(within(card).getByText('What to do: remove files you no longer need from this machine, or give Docker more disk space.')).toBeInTheDocument();
  });

  it("reads the machine's and its owner's names each in its own direction, in any language", () => {
    shown([{ ...LOW, hostname: 'מחשב-בית', owner: { id: 'p1', name: 'Lisa' } }]);
    const title = screen.getByRole('heading', { level: 3 });
    expect(title).toHaveTextContent('Machine מחשב-בית (Lisa) is low on disk space');
    expect([...title.querySelectorAll('bdi')].map(name => name.textContent)).toEqual(['מחשב-בית', 'Lisa']);
    expect(title.textContent).not.toMatch(/[\u{F0000}-\u{FFFFD}]/u);
  });

  it('says the same in Russian', () => {
    localStorage.setItem('hh-lang', 'ru');
    shown([LOW]);
    const card = screen.getByRole('region', { name: 'На машине studio-laptop (Lisa) мало места на диске' });
    expect(within(card).getByText('Свободно: 40 ГБ из 500 ГБ. Нужно не меньше 50 ГБ.')).toBeInTheDocument();
    expect(within(card).getByText('Hornhoof занимает: рабочие копии 120 ГБ, образы 60 ГБ, тома 30 ГБ, кэш сборки 20 ГБ, временные файлы проверок 5 ГБ.')).toBeInTheDocument();
    expect(within(card).getByText('Убрано за последние сутки: временные файлы проверок 9 ГБ, кэш сборки 3 ГБ.')).toBeInTheDocument();
    expect(within(card).getByText('Она продолжает свои ходы, но не берет новых проверок и сборок, пока место не освободится.')).toBeInTheDocument();
    expect(within(card).getByText('Что сделать: удалите с этой машины ненужные файлы или дайте Docker больше места на диске.')).toBeInTheDocument();
  });

  it("says how Docker's own disk does where Docker keeps its data apart", () => {
    shown([{ ...LOW, disk: { ...LOW.disk, docker: { total: 200 * GIB, free: 15 * GIB, threshold: 20 * GIB } } }]);
    expect(screen.getByText("Docker's own disk: free 15 GB of 200 GB. It needs at least 20 GB.")).toBeInTheDocument();
    cleanup();
    localStorage.setItem('hh-lang', 'ru');
    shown([{ ...LOW, disk: { ...LOW.disk, docker: { total: 200 * GIB, free: 15 * GIB, threshold: 20 * GIB } } }]);
    expect(screen.getByText('Свой диск Docker: свободно 15 ГБ из 200 ГБ. Нужно не меньше 20 ГБ.')).toBeInTheDocument();
  });

  it('names no owner when it has none, and says nothing of cleaning when the machine cleaned nothing', () => {
    shown([{ ...LOW, owner: null, disk: { ...LOW.disk, cleaned: [] } }]);
    const card = screen.getByRole('region', { name: 'Machine studio-laptop is low on disk space' });
    expect(within(card).queryByText(/^Removed in the last/)).not.toBeInTheDocument();
  });

  it("lists the work it keeps because it can't be restored, biggest first: whose, where, for which task, how big and why", () => {
    shown([KEEPS]);
    const card = screen.getByRole('region', { name: 'Machine studio-laptop (Lisa) is low on disk space' });
    const kept = within(card).getByRole('list', { name: 'Not removed: a person needs to check it' });
    expect(within(kept).getAllByRole('listitem').map(row => row.textContent)).toEqual([
      'Theo, hornhoof-1750: task 1750, 9 GB, changes not committed',
      `${STRAY}, scratch/copy: 2.5 GB, commits not pushed`,
    ]);
    expect([...kept.querySelectorAll('li:first-child bdi')].map(piece => piece.textContent)).toEqual(['Theo', 'hornhoof-1750']);
  });

  it('says what it keeps in Russian', () => {
    localStorage.setItem('hh-lang', 'ru');
    shown([KEEPS]);
    const kept = screen.getByRole('list', { name: 'Не убрано, нужна проверка человека' });
    expect(within(kept).getAllByRole('listitem').map(row => row.textContent)).toEqual([
      'Theo, hornhoof-1750: задача 1750, 9 ГБ, изменения не закоммичены',
      `${STRAY}, scratch/copy: 2,5 ГБ, коммиты не отправлены`,
    ]);
  });

  it('names the ignored files a kept copy holds, each path in its own direction, and leaves out the list when none are named', () => {
    const ignored: MachineLowCard = {
      ...LOW,
      names: { [THEO]: 'Theo' },
      disk: {
        ...LOW.disk,
        kept: [
          { part: 'workingCopies', agent: THEO, path: 'empty-list', task: 9, bytes: 512 * 1024 ** 2, why: 'ignored', ignored: [] },
          { part: 'workingCopies', agent: THEO, path: 'shop-7', task: 7, bytes: 3 * GIB, why: 'ignored', ignored: ['.env', 'local/data.sqlite'] },
          { part: 'workingCopies', agent: STRAY, path: 'empty-note', task: null, bytes: GIB, why: 'ignored' },
        ],
      },
    };
    shown([ignored]);
    const kept = screen.getByRole('list', { name: 'Not removed: a person needs to check it' });
    expect(within(kept).getAllByRole('listitem').map(row => row.textContent)).toEqual([
      'Theo, shop-7: task 7, 3 GB, ignored files not on a remote: .env, local/data.sqlite',
      `${STRAY}, empty-note: 1 GB, ignored files not on a remote`,
      'Theo, empty-list: task 9, 0.5 GB, ignored files not on a remote',
    ]);
    expect([...kept.querySelectorAll('li:first-child bdi')].map(piece => piece.textContent)).toEqual(['Theo', 'shop-7', '.env', 'local/data.sqlite']);
  });

  it('names kept ignored files in Russian', () => {
    localStorage.setItem('hh-lang', 'ru');
    const ignored: MachineLowCard = {
      ...LOW,
      names: { [THEO]: 'Theo' },
      disk: {
        ...LOW.disk,
        kept: [
          { part: 'workingCopies', agent: THEO, path: 'shop-7', task: 7, bytes: 3 * GIB, why: 'ignored', ignored: ['.env', 'local/data.sqlite'] },
          { part: 'workingCopies', agent: STRAY, path: 'empty-note', task: null, bytes: GIB, why: 'ignored' },
        ],
      },
    };
    shown([ignored]);
    const kept = screen.getByRole('list', { name: 'Не убрано, нужна проверка человека' });
    expect(within(kept).getAllByRole('listitem').map(row => row.textContent)).toEqual([
      'Theo, shop-7: задача 7, 3 ГБ, игнорируемые файлы без копии в репозитории: .env, local/data.sqlite',
      `${STRAY}, empty-note: 1 ГБ, игнорируемые файлы без копии в репозитории`,
    ]);
  });

  it('lists nothing kept when the machine keeps nothing', () => {
    shown([LOW]);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('says nothing of the parts when the machine measured none', () => {
    shown([{ ...LOW, disk: { ...LOW.disk, parts: {} } }]);
    expect(screen.queryByText(/^Hornhoof takes/)).not.toBeInTheDocument();
  });

  it('shows one card for each machine, and none when no machine is short of space', () => {
    shown([LOW, { ...LOW, id: 'm2', hostname: 'build-box', owner: null }]);
    expect(screen.getAllByRole('region').map(card => card.getAttribute('aria-label'))).toEqual(['Machine studio-laptop (Lisa) is low on disk space', 'Machine build-box is low on disk space']);
    cleanup();
    shown([]);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});
