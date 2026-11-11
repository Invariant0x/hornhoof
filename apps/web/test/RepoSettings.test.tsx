import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { RepoSettings } from '../src/ui/RepoSettings';
import type { Repository } from '../src/types';
import { mockApi } from './api-mock';

const PATH = 'PUT /api/departments/d2/repository';
const REPO: Repository = { url: 'https://github.com/acme/app.git', branch: 'main', tokenLast4: '1234', fullTestCommand: null };
const OLDER: Repository = { url: REPO.url, branch: REPO.branch, tokenLast4: REPO.tokenLast4 };
const SAVED = { url: REPO.url, branch: 'main' };
const FULL = 'Full test command';

function shown(repository: Repository, answer: [number, unknown] = [200, { repository }]) {
  const calls = mockApi({ [PATH]: answer });
  render(
    <LanguageProvider>
      <RepoSettings placeId="d2" repository={repository} />
    </LanguageProvider>,
  );
  return calls;
}

const puts = (calls: ReturnType<typeof mockApi>) => calls.filter(c => c.method === 'PUT').map(c => c.body);

describe("the repository's full test command", () => {
  it('says which command it is', () => {
    shown({ ...REPO, fullTestCommand: 'npm test' });
    expect(screen.getByText('Full test command: npm test')).toBeInTheDocument();
  });

  it('says when there is none, and what that means', () => {
    shown(REPO);
    expect(screen.getByText('No full test command, so GitHub tests every commit itself')).toBeInTheDocument();
    expect(screen.queryByText(/Full test command:/)).not.toBeInTheDocument();
  });

  it('says so of a repository saved before there was one', () => {
    shown(OLDER);
    expect(screen.getByText('No full test command, so GitHub tests every commit itself')).toBeInTheDocument();
  });

  it('is filled in when changing, says what it does, and goes out when changed, without the spaces around it', async () => {
    const user = userEvent.setup();
    const calls = shown({ ...REPO, fullTestCommand: 'npm test' });
    await user.click(screen.getByRole('button', { name: 'Change' }));
    const field = screen.getByLabelText(FULL);
    expect(field).toHaveValue('npm test');
    expect(field).toHaveAccessibleDescription(expect.stringContaining('commit statuses'));
    await user.clear(field);
    await user.type(field, '  make all  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(puts(calls)).toEqual([{ ...SAVED, fullTestCommand: 'make all' }]));
  });

  it('goes away when the field is emptied', async () => {
    const user = userEvent.setup();
    const calls = shown({ ...REPO, fullTestCommand: 'npm test' });
    await user.click(screen.getByRole('button', { name: 'Change' }));
    await user.clear(screen.getByLabelText(FULL));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(puts(calls)).toEqual([{ ...SAVED, fullTestCommand: null }]));
  });

  it.each([
    ['unchanged', { ...REPO, fullTestCommand: 'npm test' }],
    ['still none', REPO],
    ['still none on a repository saved before there was one', OLDER],
  ])('is not sent when %s', async (_what, repository) => {
    const user = userEvent.setup();
    const calls = shown(repository);
    await user.click(screen.getByRole('button', { name: 'Change' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(puts(calls)).toEqual([SAVED]));
  });

  it('can be named for a new repository', async () => {
    const user = userEvent.setup();
    const calls = mockApi({ [PATH]: [200, { repository: REPO }] });
    render(
      <LanguageProvider>
        <RepoSettings placeId="d2" repository={null} />
      </LanguageProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Connect repository' }));
    await user.type(screen.getByLabelText('Address'), REPO.url);
    await user.type(screen.getByLabelText(FULL), 'npm test');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(puts(calls)).toEqual([{ ...SAVED, fullTestCommand: 'npm test' }]));
  });

  it('stops at the length the server takes', async () => {
    const user = userEvent.setup();
    shown(REPO);
    await user.click(screen.getByRole('button', { name: 'Change' }));
    const field = screen.getByLabelText<HTMLInputElement>(FULL);
    await user.click(field);
    await user.paste('x'.repeat(4001));
    expect(field.value).toHaveLength(4000);
  });

  it('says why the server refused it, and keeps what was typed', async () => {
    const user = userEvent.setup();
    shown(REPO, [400, { error: { code: 'validation', message: 'x', reason: 'repo_command_invalid' } }]);
    await user.click(screen.getByRole('button', { name: 'Change' }));
    await user.type(screen.getByLabelText(FULL), 'vitest --shard={{part}/4');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('must also say how many parts there are');
    expect(screen.getByLabelText(FULL)).toHaveValue('vitest --shard={part}/4');
  });

  it('reads in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    onTestFinished(() => localStorage.removeItem('hh-lang'));
    const user = userEvent.setup();
    shown({ ...REPO, fullTestCommand: 'npm test' });
    expect(screen.getByText('Полная команда тестов: npm test')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Изменить' }));
    expect(screen.getByLabelText('Полная команда тестов')).toHaveValue('npm test');
  });

  it('says in Russian when there is none', () => {
    localStorage.setItem('hh-lang', 'ru');
    onTestFinished(() => localStorage.removeItem('hh-lang'));
    shown(REPO);
    expect(screen.getByText('Полной команды тестов нет, поэтому GitHub сам проверяет каждый коммит')).toBeInTheDocument();
  });
});
