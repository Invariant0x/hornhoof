import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { AgentWindow } from '../src/screens/AgentWindow';
import { Settings } from '../src/screens/Settings';
import type { EventView } from '../src/types';
import { TaskFiles } from '../src/ui/TaskAttachments';
import { CARD, ME, mockApi, ORG } from './api-mock';

vi.mock('../src/ui/AgentTerminal', () => ({
  AgentTerminal: () => (
    <div data-testid="live-terminal">
      <textarea className="xterm-helper-textarea" aria-label="Terminal input" />
    </div>
  ),
}));

const AT = new Date(new Date().setHours(11, 15, 0, 0)).toISOString();
const READY = { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 };

describe('1-click spreadsheet download in the task card materials, AgentWindow chat, and Google Sheets in Settings', () => {
  it('renders task .xlsx and .csv links with the download attribute for 1-click download under their own file names', () => {
    render(
      <LanguageProvider>
        <ul>
          <TaskFiles
            files={[
              { id: 'att-xlsx-1', name: 'partner-contacts.xlsx', size: 12_800, by: { id: 'a1', name: 'Nora' }, at: AT },
              { id: 'att-csv-2', name: 'leads-export.csv', size: 640, by: { id: 'a1', name: 'Nora' }, at: AT },
              { id: 'att-log-3', name: `review-text-${'a'.repeat(64)}.txt`, size: 900, by: { id: 'a1', name: 'Nora' }, at: AT },
            ]}
          />
        </ul>
      </LanguageProvider>,
    );
    const xlsxLink = screen.getByRole('link', { name: 'Open partner-contacts.xlsx' });
    expect(xlsxLink).toHaveAttribute('href', '/api/attachments/att-xlsx-1');
    expect(xlsxLink).toHaveAttribute('download', 'partner-contacts.xlsx');

    const csvLink = screen.getByRole('link', { name: 'Open leads-export.csv' });
    expect(csvLink).toHaveAttribute('href', '/api/attachments/att-csv-2');
    expect(csvLink).toHaveAttribute('download', 'leads-export.csv');

    /* A text Hornhoof keeps for a task opens to be read, under its short name. */
    const textLink = screen.getByRole('link', { name: 'Open review-text.txt' });
    expect(textLink).toHaveAttribute('target', '_blank');
    expect(textLink).not.toHaveAttribute('download');
  });

  it('renders agent chat reply .xlsx and .csv attachments as 1-click download links inside AgentWindow', async () => {
    const events: EventView[] = [
      {
        seq: 1,
        kind: 'text',
        jobId: 'j1',
        person: null,
        at: AT,
        data: {
          text: 'Here is the requested contact spreadsheet.',
          pictures: [
            { id: 'chat-xlsx-1', name: 'contacts.xlsx', file: true },
            { id: 'chat-csv-1', name: 'contacts.csv', file: true },
          ],
        },
      },
    ];
    mockApi({
      'GET /api/agents/orchestrator': [200, { ...CARD, id: ORG.orchestrator!.id, kind: 'orchestrator', name: 'Orchestrator' }],
      'GET /api/agents/orchestrator/events?last=300': [200, { events, state: READY }],
      'POST /api/agents/orchestrator/start': [200, { started: false }],
    });
    render(
      <LanguageProvider>
        <AgentWindow me={ME} org={ORG} agentId="orchestrator" onClose={() => {}} />
      </LanguageProvider>,
    );
    expect(await screen.findByText('Here is the requested contact spreadsheet.')).toBeInTheDocument();
    const xlsxDownload = screen.getByRole('link', { name: /contacts\.xlsx/i });
    expect(xlsxDownload).toHaveAttribute('href', '/api/attachments/chat-xlsx-1');
    expect(xlsxDownload).toHaveAttribute('download', 'contacts.xlsx');

    const csvDownload = screen.getByRole('link', { name: /contacts\.csv/i });
    expect(csvDownload).toHaveAttribute('href', '/api/attachments/chat-csv-1');
    expect(csvDownload).toHaveAttribute('download', 'contacts.csv');
  });

  it('shows Google Sheets as a card under Integrations in Settings, connects it and says it is connected, in English and Russian', async () => {
    const user = userEvent.setup();
    localStorage.setItem('hh-lang', 'en');
    const calls = mockApi({
      'GET /api/link': [200, { link: null, domain: 'hornhoof.org' }],
      'GET /api/repo-host': [200, { host: null }],
      'GET /api/google-sheets': [200, { google: null }],
      'PUT /api/google-sheets': [
        200,
        {
          google: {
            kind: 'service_account',
            account: 'sheets-bot@acme.iam.gserviceaccount.com',
            shareEmail: 'ivan@acme.com',
            keyLast4: '9876',
          },
        },
      ],
    });
    const first = render(
      <LanguageProvider>
        <Settings me={ME} group="integrations" onClose={() => {}} />
      </LanguageProvider>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    const part = await within(dialog).findByRole('article', { name: 'Google Sheets' });
    expect(part).toHaveClass('integration');
    expect(within(part).getByText('Not connected')).toHaveAttribute('data-connected', 'false');
    expect(within(dialog).getByRole('button', { name: 'Integrations' })).toHaveAttribute('aria-current', 'page');
    /* Not connected, Connect is the record's one action and its main button (spec 4.4). */
    const connect = within(part).getByRole('button', { name: 'Connect Google Sheets' });
    expect(connect).toHaveClass('btn');
    expect(connect).not.toHaveClass('ghost');
    await user.click(connect);
    await user.type(within(part).getByLabelText('Google key JSON'), '{{"type":"service_account"}');
    await user.type(within(part).getByLabelText('Share new spreadsheets with'), 'ivan@acme.com');
    await user.click(within(part).getByRole('button', { name: 'Save' }));
    expect(await within(part).findByText(/sheets-bot@acme\.iam\.gserviceaccount\.com/)).toBeInTheDocument();
    expect(within(part).getByText('Connected')).toHaveAttribute('data-connected', 'true');
    /* Connected, Disconnect is the pink secondary button, last of its row. */
    const disconnect = within(part).getByRole('button', { name: 'Disconnect' });
    expect(disconnect).toHaveClass('btn', 'ghost', 'danger');
    expect(disconnect.parentElement!.lastElementChild).toBe(disconnect);
    expect(within(part).getByRole('button', { name: 'Change settings' })).not.toHaveClass('danger');
    expect(calls.find(c => c.method === 'PUT' && c.path === '/api/google-sheets')).toEqual({
      method: 'PUT',
      path: '/api/google-sheets',
      body: { credentials: '{"type":"service_account"}', shareEmail: 'ivan@acme.com' },
    });
    first.unmount();

    localStorage.setItem('hh-lang', 'ru');
    mockApi({
      'GET /api/link': [200, { link: null, domain: 'hornhoof.org' }],
      'GET /api/repo-host': [200, { host: null }],
      'GET /api/google-sheets': [200, { google: null }],
    });
    render(
      <LanguageProvider>
        <Settings me={ME} group="integrations" onClose={() => {}} />
      </LanguageProvider>,
    );
    const ruDialog = await screen.findByRole('dialog', { name: 'Настройки' });
    const ruPart = await within(ruDialog).findByRole('article', { name: 'Google Таблицы' });
    expect(within(ruPart).getByText('Не подключено')).toBeInTheDocument();
    expect(within(ruDialog).getByRole('button', { name: 'Интеграции' })).toHaveAttribute('aria-current', 'page');
    localStorage.removeItem('hh-lang');
  });

  it('says in plain words that a service account key needs the Google account its spreadsheets open for', async () => {
    const user = userEvent.setup();
    const said = {
      en: 'A service account opens the spreadsheets it creates to no one else. Enter the email of the Google account to share them with.',
      ru: 'Сервисный аккаунт никому не открывает созданные им таблицы. Укажите почту аккаунта Google, которому открывать к ним доступ.',
    };
    for (const lang of ['en', 'ru'] as const) {
      localStorage.setItem('hh-lang', lang);
      mockApi({
        'GET /api/link': [200, { link: null, domain: 'hornhoof.org' }],
        'GET /api/repo-host': [200, { host: null }],
        'GET /api/google-sheets': [200, { google: null }],
        'PUT /api/google-sheets': [400, { error: { code: 'validation', reason: 'google_sheets_share_needed', message: 'Share needed.' } }],
      });
      const shown = render(
        <LanguageProvider>
          <Settings me={ME} group="integrations" onClose={() => {}} />
        </LanguageProvider>,
      );
      const part = await screen.findByRole('article', { name: lang === 'en' ? 'Google Sheets' : 'Google Таблицы' });
      await user.click(within(part).getByRole('button', { name: lang === 'en' ? 'Connect Google Sheets' : 'Подключить Google Таблицы' }));
      await user.type(within(part).getByLabelText(lang === 'en' ? 'Google key JSON' : 'JSON-ключ Google'), '{{"type":"service_account"}');
      await user.click(within(part).getByRole('button', { name: lang === 'en' ? 'Save' : 'Сохранить' }));
      expect(await within(part).findByRole('alert')).toHaveTextContent(said[lang]);
      shown.unmount();
    }
    localStorage.removeItem('hh-lang');
  });

  it('confirms disconnecting Google Sheets in a dialog naming its account and keeps errors inside', async () => {
    const user = userEvent.setup();
    let fail = true;
    const calls = mockApi({
      'GET /api/link': [200, { link: null, domain: 'hornhoof.org' }],
      'GET /api/repo-host': [200, { host: null }],
      'GET /api/google-sheets': [
        200,
        { google: { kind: 'service_account', account: 'sheets-bot@acme.iam.gserviceaccount.com', shareEmail: 'ivan@acme.com', keyLast4: '9876' } },
      ],
      'DELETE /api/google-sheets': () => (fail ? [500, { error: { code: 'internal', message: 'Cannot disconnect.' } }] : [204]),
    });
    render(
      <LanguageProvider>
        <Settings me={ME} group="integrations" onClose={() => {}} />
      </LanguageProvider>,
    );
    const part = await screen.findByRole('article', { name: 'Google Sheets' });
    await user.click(within(part).getByRole('button', { name: 'Disconnect' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Do you really want to disconnect Google Sheets?' });
    expect(dialog).toHaveAccessibleDescription(
      'Google Sheets for sheets-bot@acme.iam.gserviceaccount.com will be disconnected. Employees will stop creating new Google Sheets links and will attach .xlsx files instead.',
    );
    expect(within(dialog).getByText('sheets-bot@acme.iam.gserviceaccount.com').tagName).toBe('BDI');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.some(c => c.method === 'DELETE')).toBe(false);

    await user.click(within(part).getByRole('button', { name: 'Disconnect' }));
    const again = screen.getByRole('alertdialog');
    await user.click(within(again).getByRole('button', { name: 'Disconnect' }));
    expect(await within(again).findByRole('alert')).toHaveTextContent('Cannot disconnect.');
    fail = false;
    await user.click(within(again).getByRole('button', { name: 'Disconnect' }));
    expect(await within(part).findByRole('button', { name: 'Connect Google Sheets' })).toBeInTheDocument();
    expect(calls.filter(c => c.method === 'DELETE' && c.path === '/api/google-sheets')).toHaveLength(2);
  });
});
