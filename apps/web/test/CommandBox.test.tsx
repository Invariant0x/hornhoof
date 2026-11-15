import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { CommandBox, windowsCommand } from '../src/ui/CommandBox';
import { mockApi, TEST_KEY, withKey } from './api-mock';
import { decl } from './css';

const JOIN = 'curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join -Ab3_d-Ef';
const WINDOWS_JOIN = 'powershell -ExecutionPolicy Bypass -c "& ([scriptblock]::Create((irm https://hq.acme.com/install.ps1))) --join -Ab3_d-Ef"';
/* A command that joins a machine shows with the key of whoever looks at it, and so does its Windows form. */
const WINDOWS_JOIN_WITH_KEY = `${WINDOWS_JOIN.slice(0, -1)} --owner-key ${TEST_KEY.publicKey}"`;
const UPDATE = 'curl -fsSL http://192.0.2.20:8080/install.sh | bash';
const WINDOWS_UPDATE = 'powershell -ExecutionPolicy Bypass -c "irm http://192.0.2.20:8080/install.ps1 | iex"';

afterEach(() => { localStorage.clear(); });

describe('the same command for Windows', () => {
  it('runs install.ps1 of the same server with the same words', () => {
    expect(windowsCommand(JOIN)).toBe(WINDOWS_JOIN);
    expect(windowsCommand(UPDATE)).toBe(WINDOWS_UPDATE);
    expect(windowsCommand(withKey(JOIN))).toBe(WINDOWS_JOIN_WITH_KEY);
  });

  it('is none for a command of another kind', () => {
    for (const other of ['curl x', 'curl -fsSL https://hq.acme.com/install.sh | bash -s -- server', `${JOIN}; rm -rf ~`, `${JOIN} --owner-key short`, `${withKey(JOIN)}; rm -rf ~`, 'curl -fsSL https://hq.acme.com/install.sh | sh']) {
      expect(windowsCommand(other)).toBeNull();
    }
  });
});

describe('an install command on the screen', () => {
  it.each([
    ['en', 'On a Mac or Linux, run this in Terminal:', 'On Windows, run this in PowerShell:', 'Copy'],
    ['ru', 'На Mac или в Linux выполните это в Терминале:', 'В Windows выполните это в PowerShell:', 'Копировать'],
  ])('%s: shows the command for a Mac or Linux and the one for Windows, each with its own Copy', async (language, unix, windows, copy) => {
    localStorage.setItem('hh-lang', language);
    mockApi({});
    render(<LanguageProvider><CommandBox command={JOIN} /></LanguageProvider>);
    const mac = await screen.findByRole('group', { name: unix });
    expect(within(mac).getByText(withKey(JOIN))).toBeInTheDocument();
    expect(within(mac).getByRole('button', { name: copy })).toBeInTheDocument();
    const win = screen.getByRole('group', { name: windows });
    expect(within(win).getByText(WINDOWS_JOIN_WITH_KEY)).toBeInTheDocument();
    expect(within(win).getByRole('button', { name: copy })).toBeInTheDocument();
  });

  it('shows a command of another kind alone, as before', () => {
    render(<LanguageProvider><CommandBox command="curl x" /></LanguageProvider>);
    expect(screen.getByText('curl x')).toBeInTheDocument();
    expect(screen.queryByText(/PowerShell/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(1);
  });
});

/* Design's rule 15 of section 6 (#1036): a command with a copy button has the button in the group under the text, on
   the end edge, from 44 px, at any width. */
describe("an install command's Copy", () => {
  it('stands in a group of its own under the command, a button of 44 px', async () => {
    mockApi({});
    render(<LanguageProvider><CommandBox command={JOIN} /></LanguageProvider>);
    await screen.findByRole('group', { name: 'On a Mac or Linux, run this in Terminal:' });
    for (const copy of screen.getAllByRole('button', { name: 'Copy' })) {
      const group = copy.parentElement!;
      expect(group).toHaveClass('entry-actions');
      expect(group.previousElementSibling?.tagName).toBe('CODE');
      expect(group.parentElement).toHaveClass('command');
      expect(copy).toHaveClass('btn', 'ghost');
      expect(copy).not.toHaveClass('small');
    }
  });

  it('lays the command out in one column, the group under it with 8 px between', () => {
    expect(decl('.command', 'grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(decl('.command', 'gap')).toBe('8px');
    expect(decl('.entry-actions', 'justify-content')).toBe('flex-end');
    expect(decl('.entry-actions', 'flex-wrap')).toBe('wrap');
  });
});
