import type { DiskReport, MachineReplicas } from '@hornhoof/protocol';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Machines } from '../src/screens/Machines';
import { MACHINES, ME, mockApi, SUBS } from './api-mock';

const GIB = 1024 ** 3;
/* A made-up Mac's disk: 120 GB free of 460, Hornhoof's 113 GB by part, and Docker's own disk inside its virtual machine. The
   nodes' own folders, 19 GB of working copies, recordings and check temp files, are inside the 30 GB of volumes. */
const DISK: DiskReport = {
  total: 460 * GIB,
  free: 120 * GIB,
  threshold: 50 * GIB,
  docker: { total: 200 * GIB, free: 85 * GIB, threshold: 20 * GIB },
  parts: { images: 60 * GIB, containers: 3 * GIB, volumes: 30 * GIB, buildCache: 20 * GIB, workingCopies: 12 * GIB, recordings: 2 * GIB, checkTemp: 5 * GIB },
  low: null,
  cleaned: [],
};
const LOW: DiskReport = { ...DISK, free: 40 * GIB, low: { since: '2026-11-20T10:00:00.000Z' } };

/* Two copies of company databases on the machine, inside Docker's volumes; the server names the one company it serves. */
const REPLICAS: MachineReplicas = { count: 2, bytes: 14 * GIB, companies: [{ name: 'Acme Robotics', bytes: 14 * GIB }] };

type Folders = { plan: string | null; bytes: number }[];
const withDisk = (disk: DiskReport | undefined, replicas?: MachineReplicas, folders?: Folders) =>
  mockApi({
    'GET /api/subscriptions': [200, { subscriptions: SUBS }],
    'GET /api/machines': [200, { machines: [{ ...MACHINES[0]!, load: { ...MACHINES[0]!.load!, ...(disk ? { disk } : {}) }, ...(replicas ? { replicas } : {}), ...(folders ? { folders } : {}) }], builtin: null }],
  });
/* The working copies of the laptop's two plans' nodes, 12 GB together, and of its own node, which has none. */
const FOLDERS: Folders = [{ plan: 's-codex', bytes: 8 * GIB }, { plan: 's-claude', bytes: 4 * GIB }, { plan: null, bytes: 0 }];

async function laptop() {
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: /^(Open the card of |Открыть карточку )dev-laptop$/ }));
  return screen.getByRole('article', { name: 'dev-laptop' });
}
const partOf = (card: HTMLElement, title: string) => within(card).getByRole('heading', { name: title }).closest('section')!;
const rows = (part: HTMLElement) => within(part).getAllByRole('listitem').map(row => row.textContent);

afterEach(() => localStorage.clear());

describe("a machine's disk on its card", () => {
  it("shows what Hornhoof takes by part, all of it together, counting the nodes' folders once in the volumes, everything else and Docker's own disk", async () => {
    withDisk(DISK);
    render(<Machines me={ME} />);
    const disk = partOf(await laptop(), 'Disk by part');
    /* Largest first, each bar on the scale of the whole disk. */
    expect(rows(disk)).toEqual(['Images60 GB', 'Volumes30 GB', 'Build cache20 GB', 'Working copies, in the volumes12 GB', 'Check temp files, in the volumes5 GB', 'Containers3 GB', 'Terminal recordings, in the volumes2 GB']);
    expect(within(disk).getAllByRole('listitem').map(row => row.querySelector('.bar i')?.getAttribute('style'))).toEqual(['width: 13%;', 'width: 7%;', 'width: 4%;', 'width: 3%;', 'width: 1%;', 'width: 1%;', 'width: 0%;']);
    expect(within(disk).getByText('Hornhoof in all: 113 GB of 460 GB')).toBeInTheDocument();
    expect(within(disk).getByText('Everything else: 227 GB')).toBeInTheDocument();
    expect(within(disk).getByText("Docker's own disk: 85 GB free of 200 GB")).toBeInTheDocument();
  });

  it('says the same in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    withDisk(DISK);
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    const disk = partOf(await laptop(), 'Диск по частям');
    expect(rows(disk)).toEqual(['Образы60 ГБ', 'Тома30 ГБ', 'Кэш сборки20 ГБ', 'Рабочие копии, в томах12 ГБ', 'Временные файлы проверок, в томах5 ГБ', 'Контейнеры3 ГБ', 'Записи терминалов, в томах2 ГБ']);
    expect(within(disk).getByText('Hornhoof всего: 113 ГБ из 460 ГБ')).toBeInTheDocument();
    expect(within(disk).getByText('Все остальное: 227 ГБ')).toBeInTheDocument();
    expect(within(disk).getByText('Свой диск Docker: свободно 85 ГБ из 200 ГБ')).toBeInTheDocument();
  });

  it("shows the copies of company databases as a part of its own, the companies named, and counts them once, in the volumes", async () => {
    withDisk(DISK, REPLICAS);
    render(<Machines me={ME} />);
    const disk = partOf(await laptop(), 'Disk by part');
    expect(rows(disk)).toEqual(['Images60 GB', 'Volumes30 GB', 'Build cache20 GB', 'Company database copies, in the volumes: 2 (Acme Robotics)14 GB', 'Working copies, in the volumes12 GB', 'Check temp files, in the volumes5 GB', 'Containers3 GB', 'Terminal recordings, in the volumes2 GB']);
    const copies = within(disk).getAllByRole('listitem')[3]!;
    expect(copies.querySelector('.bar i')?.getAttribute('style')).toBe('width: 3%;');
    expect([...copies.querySelectorAll('.dp-n bdi')].map(name => name.textContent)).toEqual(['Acme Robotics']);
    expect(within(disk).getByText('Hornhoof in all: 113 GB of 460 GB')).toBeInTheDocument();
  });

  it("shows the employees' working folders of each node as a row of its own, named by its plan, the biggest first, in the volumes", async () => {
    withDisk(DISK, undefined, FOLDERS);
    render(<Machines me={ME} />);
    const disk = partOf(await laptop(), 'Disk by part');
    expect(rows(disk)).toEqual([
      'Images60 GB', 'Volumes30 GB', 'Build cache20 GB', "Employees' working folders on Codex, in the volumes8 GB", 'Check temp files, in the volumes5 GB',
      "Employees' working folders on Claude, in the volumes4 GB", 'Containers3 GB', 'Terminal recordings, in the volumes2 GB', "Employees' working folders on the machine's own node, in the volumes0 GB",
    ]);
    expect([...disk.querySelectorAll('.dp-n bdi')].map(name => name.textContent)).toEqual(['Codex', 'Claude']);
    expect(within(disk).getAllByRole('listitem')[3]!.querySelector('.bar i')?.getAttribute('style')).toBe('width: 2%;');
    expect(within(disk).getByText('Hornhoof in all: 113 GB of 460 GB')).toBeInTheDocument();
  });

  it("says each node's working folders in Russian", async () => {
    localStorage.setItem('hh-lang', 'ru');
    withDisk(DISK, undefined, FOLDERS);
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    const disk = partOf(await laptop(), 'Диск по частям');
    expect(rows(disk)).toEqual([
      'Образы60 ГБ', 'Тома30 ГБ', 'Кэш сборки20 ГБ', 'Рабочие папки сотрудников на Codex, в томах8 ГБ', 'Временные файлы проверок, в томах5 ГБ',
      'Рабочие папки сотрудников на Claude, в томах4 ГБ', 'Контейнеры3 ГБ', 'Записи терминалов, в томах2 ГБ', 'Рабочие папки сотрудников на собственной ноде машины, в томах0 ГБ',
    ]);
  });

  it('says the copies in Russian, and says none when the machine holds none', async () => {
    localStorage.setItem('hh-lang', 'ru');
    withDisk(DISK, { count: 0, bytes: 0, companies: [] });
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    const disk = partOf(await laptop(), 'Диск по частям');
    expect(rows(disk)).toContain('Копии баз компаний, в томах: 00 ГБ');
  });

  it("leaves out what the node could not measure, and Docker's own disk where Docker has none", async () => {
    withDisk({ total: DISK.total, free: DISK.free, threshold: DISK.threshold, parts: { workingCopies: 12 * GIB }, low: null, cleaned: [] });
    render(<Machines me={ME} />);
    const disk = partOf(await laptop(), 'Disk by part');
    expect(rows(disk)).toEqual(['Working copies12 GB']);
    expect(within(disk).getByText('Hornhoof in all: 12 GB of 460 GB')).toBeInTheDocument();
    expect(within(disk).queryByText(/^Docker's own disk/)).not.toBeInTheDocument();
  });

  it('shows no such part for a node too old to say it', async () => {
    withDisk(undefined);
    render(<Machines me={ME} />);
    const mac = await laptop();
    expect(within(mac).queryByRole('heading', { name: 'Disk by part' })).not.toBeInTheDocument();
  });

  it('says the machine takes no new checks or builds while it is short of space, and says nothing once it has room', async () => {
    withDisk(LOW);
    render(<Machines me={ME} />);
    const mac = await laptop();
    const disk = partOf(mac, 'Disk by part');
    expect(within(disk).getByRole('status')).toHaveTextContent(/^Short of disk space since .+: it takes no new checks or builds until space is back\. Its turns go on\.$/);
    const mark = within(mac).getByText('Low on disk', { selector: '.badge' });
    expect(mark.getAttribute('title')).toMatch(/^Short of disk space since /);
    /* In the machine's row too, which the open card stands under. */
    expect(screen.getAllByText('Low on disk', { selector: '.badge' })).toHaveLength(2);
  });

  it('says nothing of a shortage while the machine has room', async () => {
    withDisk(DISK);
    render(<Machines me={ME} />);
    const disk = partOf(await laptop(), 'Disk by part');
    expect(within(disk).queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('Low on disk', { selector: '.badge' })).not.toBeInTheDocument();
  });
});
