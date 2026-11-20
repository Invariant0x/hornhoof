import type { DiskReport, MachineReplicas } from '@hornhoof/protocol';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Machines } from '../src/screens/Machines';
import { MACHINES, ME, mockApi, SUBS } from './api-mock';

const GIB = 1024 ** 3;
/* A made-up Mac's disk: 120 GB free of 460, Hornhoof's 132 GB by part, and Docker's own disk inside its virtual machine. */
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

const withDisk = (disk: DiskReport | undefined, replicas?: MachineReplicas) =>
  mockApi({
    'GET /api/subscriptions': [200, { subscriptions: SUBS }],
    'GET /api/machines': [200, { machines: [{ ...MACHINES[0]!, load: { ...MACHINES[0]!.load!, ...(disk ? { disk } : {}) }, ...(replicas ? { replicas } : {}) }], builtin: null }],
  });

async function laptop() {
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: /^(Open the card of |Открыть карточку )dev-laptop$/ }));
  return screen.getByRole('article', { name: 'dev-laptop' });
}
const partOf = (card: HTMLElement, title: string) => within(card).getByRole('heading', { name: title }).closest('section')!;
const rows = (part: HTMLElement) => within(part).getAllByRole('listitem').map(row => row.textContent);

afterEach(() => localStorage.clear());

describe("a machine's disk on its card", () => {
  it("shows what Hornhoof takes by part, all of it together, everything else and Docker's own disk", async () => {
    withDisk(DISK);
    render(<Machines me={ME} />);
    const disk = partOf(await laptop(), 'Disk by part');
    /* Largest first, each bar on the scale of the whole disk. */
    expect(rows(disk)).toEqual(['Images60 GB', 'Volumes30 GB', 'Build cache20 GB', 'Working copies12 GB', 'Check temp files5 GB', 'Containers3 GB', 'Terminal recordings2 GB']);
    expect(within(disk).getAllByRole('listitem').map(row => row.querySelector('.bar i')?.getAttribute('style'))).toEqual(['width: 13%;', 'width: 7%;', 'width: 4%;', 'width: 3%;', 'width: 1%;', 'width: 1%;', 'width: 0%;']);
    expect(within(disk).getByText('Hornhoof in all: 132 GB of 460 GB')).toBeInTheDocument();
    expect(within(disk).getByText('Everything else: 208 GB')).toBeInTheDocument();
    expect(within(disk).getByText("Docker's own disk: 85 GB free of 200 GB")).toBeInTheDocument();
  });

  it('says the same in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    withDisk(DISK);
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    const disk = partOf(await laptop(), 'Диск по частям');
    expect(rows(disk)).toEqual(['Образы60 ГБ', 'Тома30 ГБ', 'Кэш сборки20 ГБ', 'Рабочие копии12 ГБ', 'Временные файлы проверок5 ГБ', 'Контейнеры3 ГБ', 'Записи терминалов2 ГБ']);
    expect(within(disk).getByText('Hornhoof всего: 132 ГБ из 460 ГБ')).toBeInTheDocument();
    expect(within(disk).getByText('Все остальное: 208 ГБ')).toBeInTheDocument();
    expect(within(disk).getByText('Свой диск Docker: свободно 85 ГБ из 200 ГБ')).toBeInTheDocument();
  });

  it("shows the copies of company databases as a part of its own, the companies named, and counts them once, in the volumes", async () => {
    withDisk(DISK, REPLICAS);
    render(<Machines me={ME} />);
    const disk = partOf(await laptop(), 'Disk by part');
    expect(rows(disk)).toEqual(['Images60 GB', 'Volumes30 GB', 'Build cache20 GB', 'Company database copies, in the volumes: 2 (Acme Robotics)14 GB', 'Working copies12 GB', 'Check temp files5 GB', 'Containers3 GB', 'Terminal recordings2 GB']);
    const copies = within(disk).getAllByRole('listitem')[3]!;
    expect(copies.querySelector('.bar i')?.getAttribute('style')).toBe('width: 3%;');
    expect([...copies.querySelectorAll('.dp-n bdi')].map(name => name.textContent)).toEqual(['Acme Robotics']);
    expect(within(disk).getByText('Hornhoof in all: 132 GB of 460 GB')).toBeInTheDocument();
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
