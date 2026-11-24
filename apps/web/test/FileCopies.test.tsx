import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { FileCopies, type FileStoreView } from '../src/screens/FileCopies';
import { mockApi } from './api-mock';

const GB = 1024 ** 3;
const viewOf = (over: Partial<FileStoreView> = {}): FileStoreView => ({
  copies: 2, effectiveCopies: 2, machines: 3, filesBytes: 3.4 * GB, usedBytes: 6.8 * GB, capacityBytes: 15 * GB, underCopied: 0, stuckBytes: 0, ...over,
});
const shown = () => render(<LanguageProvider><FileCopies /></LanguageProvider>);

afterEach(() => vi.unstubAllGlobals());

describe('File copies in Settings', () => {
  it('shows how many machines keep each file and what the files take, and sets another number', async () => {
    const calls = mockApi({ 'GET /api/company/file-store': [200, viewOf()], 'PATCH /api/company/file-store': body => [200, viewOf({ copies: (body as { copies: number }).copies, effectiveCopies: 3, capacityBytes: 10 * GB })] });
    shown();
    const select = await screen.findByRole('combobox', { name: 'File copies across machines' });
    expect(select).toHaveValue('2');
    expect(screen.getByText('Each file is kept on 2 machines now. 3 machines keep files.')).toBeInTheDocument();
    expect(screen.getByText("The files take 3.4 GB of the 15.0 GB the machines' areas hold.")).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await userEvent.selectOptions(select, '3');
    await waitFor(() => expect(calls.find(call => call.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/api/company/file-store', body: { copies: 3 } }));
    expect(await screen.findByText('Each file is kept on 3 machines now. 3 machines keep files.')).toBeInTheDocument();
  });

  it('says when one machine keeps files, when files are kept fewer times than asked, and what waits for room', async () => {
    mockApi({ 'GET /api/company/file-store': [200, viewOf({ effectiveCopies: 1, machines: 1, underCopied: 4, stuckBytes: 600 * 1024 * 1024 })] });
    shown();
    expect(await screen.findByText('Only one machine keeps files, so each file has one copy. Connect another machine with a keeper to keep a second.')).toBeInTheDocument();
    expect(screen.getByText('4 files are kept fewer times than asked. They are copied once a machine with room is online.')).toBeInTheDocument();
    expect(screen.getByText('600 MB wait on a machine that is to give them up, until another machine has room for them.')).toBeInTheDocument();
  });

  it('says when no machine keeps files', async () => {
    mockApi({ 'GET /api/company/file-store': [200, viewOf({ effectiveCopies: 0, machines: 0, capacityBytes: 0 })] });
    shown();
    expect(await screen.findByText('No machine keeps files now. Give a machine an area for them in its settings.')).toBeInTheDocument();
    expect(screen.queryByText(/^Each file is kept on/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Only one machine keeps files/)).not.toBeInTheDocument();
  });

  it('says why a new number was not set, and keeps the one set', async () => {
    mockApi({ 'GET /api/company/file-store': [200, viewOf()], 'PATCH /api/company/file-store': [403, { error: { code: 'forbidden', message: 'Only the CEO can do this.' } }] });
    shown();
    const select = await screen.findByRole('combobox', { name: 'File copies across machines' });
    await userEvent.selectOptions(select, '4');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(select).toHaveValue('2');
  });

  it('shows nothing on a server from before the store', async () => {
    mockApi({});
    const { container } = shown();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
