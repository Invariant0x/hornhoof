import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import { ME, mockApi, ORG } from './api-mock';

/* A person writes a bug, an improvement or an idea to Hornhoof's developers in a quick window: they see exactly what goes,
   with the technical data beside it, and nothing leaves until they press Send. */

const PERSON = { ...ME, person: { ...ME.person, scopeKind: 'listed' as const, isOwner: false } };
type Body = { kind: string; title: string; text: string; improvement?: string };
const FACTS = { version: '0.18.11', platform: ['darwin arm64', 'linux x64'], errorCode: null };

/* The server's preview: what it would send for what the window holds, as the server cleans it. */
const previewOf = (body: Body) => [
  200,
  {
    report: { kind: body.kind, title: body.title.replace('ivan@acme.example', '[email]'), text: body.text.replace(/ghp_\w+/, '[secret]').replace('/home/ivan/shop', '[path]'), facts: FACTS },
    hidden: { secret: body.text.includes('ghp_') ? 1 : 0, email: body.title.includes('@') ? 1 : 0, address: 0, path: body.text.includes('/home/') ? 1 : 0 },
    digest: 'd'.repeat(64),
  },
] as [number, unknown];

function page(routes: Record<string, unknown> = {}, language = 'en') {
  localStorage.setItem('hh-lang', language);
  const calls = mockApi({
    'GET /api/org': [200, ORG],
    'GET /api/feedback': [200, { inbox: false }],
    'POST /api/feedback/preview': (body: Body) => previewOf(body),
    'POST /api/feedback': [200, { sent: true }],
    ...(routes as Record<string, [number, unknown]>),
  });
  render(<LanguageProvider><Shell me={PERSON} onSignOut={() => {}} /></LanguageProvider>);
  return { user: userEvent.setup(), calls };
}

async function openFeedback(user: ReturnType<typeof userEvent.setup>, account = 'Account', item = 'Feedback', title = 'Write to Hornhoof developers') {
  await user.click(screen.getByRole('button', { name: account }));
  await user.click(screen.getByRole('button', { name: item }));
  return screen.findByRole('dialog', { name: title });
}

const sent = (calls: ReturnType<typeof mockApi>) => calls.filter(c => c.method === 'POST' && c.path === '/api/feedback');

afterEach(() => localStorage.clear());

describe('the feedback window', () => {
  it('lets a person pick bug, improvement or idea, then shows what goes and sends it only when they press Send', async () => {
    const { user, calls } = page();
    const box = await openFeedback(user);
    const kinds = within(box).getByRole('group', { name: 'What is it' });
    expect(within(kinds).getAllByRole('button').map(b => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Bug', 'true'],
      ['Improvement', 'false'],
      ['Idea', 'false'],
    ]);
    await user.click(within(kinds).getByRole('button', { name: 'Improvement' }));
    await user.click(within(kinds).getByRole('button', { name: 'Bug' }));
    await user.type(within(box).getByLabelText('Title'), 'Terminal froze for ivan@acme.example');
    await user.type(within(box).getByLabelText('What happened, or what you would like'), 'In /home/ivan/shop the key ghp_abc123 showed');
    expect(within(box).getByText(/hides keys, passwords, email, addresses and home folder paths/)).toBeInTheDocument();
    await user.click(within(box).getByRole('button', { name: 'Next' }));

    const check = await within(box).findByRole('region', { name: 'This goes to Hornhoof developers' });
    expect(calls.filter(c => c.path === '/api/feedback/preview').map(c => c.body)).toEqual([{ kind: 'bug', title: 'Terminal froze for ivan@acme.example', text: 'In /home/ivan/shop the key ghp_abc123 showed' }]);
    const terms = within(check).getAllByRole('term').map(term => term.textContent);
    const values = within(check).getAllByRole('definition').map(d => d.textContent);
    expect(Object.fromEntries(terms.map((term, i) => [term, values[i]]))).toEqual({
      Kind: 'Bug',
      Title: 'Terminal froze for [email]',
      Description: 'In [path] the key [secret] showed',
      'Hornhoof version': '0.18.11',
      'Machines of the company': 'darwin arm64, linux x64',
    });
    expect(within(check).getByText('Hidden before sending: keys and passwords 1, email 1, home folder paths 1.')).toBeInTheDocument();
    expect(sent(calls)).toEqual([]);

    await user.click(within(box).getByRole('button', { name: 'Send' }));
    expect(await within(box).findByText('Sent. Thank you, Hornhoof developers will read it.')).toBeInTheDocument();
    expect(sent(calls).map(c => c.body)).toEqual([{ kind: 'bug', title: 'Terminal froze for ivan@acme.example', text: 'In /home/ivan/shop the key ghp_abc123 showed', digest: 'd'.repeat(64) }]);
    await user.click(within(box).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('goes back with what was written kept, and needs a title before it shows anything', async () => {
    const { user, calls } = page();
    const box = await openFeedback(user);
    await user.click(within(box).getByRole('button', { name: 'Next' }));
    expect(within(box).getByText('Write a title.')).toBeInTheDocument();
    expect(calls.filter(c => c.path === '/api/feedback/preview')).toEqual([]);
    await user.click(within(box).getByRole('button', { name: 'Idea' }));
    await user.type(within(box).getByLabelText('Title'), 'A dark map');
    await user.click(within(box).getByRole('button', { name: 'Next' }));
    await within(box).findByRole('region', { name: 'This goes to Hornhoof developers' });
    await user.click(within(box).getByRole('button', { name: 'Back' }));
    expect(within(box).getByLabelText('Title')).toHaveValue('A dark map');
    expect(within(box).getByRole('button', { name: 'Idea' })).toHaveAttribute('aria-pressed', 'true');
    expect(sent(calls)).toEqual([]);
  });

  it('says what went wrong and keeps the window open to try again', async () => {
    const { user } = page({ 'POST /api/feedback': [503, { error: { code: 'unavailable', reason: 'relay_unreachable', message: 'hornhoof.org does not answer now. Try again in a few minutes.' } }] });
    const box = await openFeedback(user);
    await user.type(within(box).getByLabelText('Title'), 'Froze');
    await user.click(within(box).getByRole('button', { name: 'Next' }));
    await within(box).findByRole('region', { name: 'This goes to Hornhoof developers' });
    await user.click(within(box).getByRole('button', { name: 'Send' }));
    expect(await within(box).findByRole('alert')).toHaveTextContent('hornhoof.org does not answer now. Try again in a few minutes.');
    expect(within(box).getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('says on Hornhoof’s own installation that it went into the inbox', async () => {
    const { user } = page({ 'GET /api/feedback': [200, { inbox: true }] });
    const box = await openFeedback(user);
    await user.type(within(box).getByLabelText('Title'), 'Froze');
    await user.click(within(box).getByRole('button', { name: 'Next' }));
    await within(box).findByRole('region', { name: 'This goes to the inbox of Hornhoof developers' });
    await user.click(within(box).getByRole('button', { name: 'Send' }));
    expect(await within(box).findByText('Added to the inbox.')).toBeInTheDocument();
  });

  it('opens from About in place of the old link to GitHub', async () => {
    const { user } = page({ 'GET /api/updates/current': [200, { version: '0.18.11', commit: 'abc1234' }] });
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'About' }));
    const about = await screen.findByRole('dialog', { name: 'About Hornhoof' });
    expect(within(about).queryByRole('link', { name: 'Report a bug or suggest an idea' })).not.toBeInTheDocument();
    await user.click(within(about).getByRole('button', { name: 'Report a bug or suggest an idea' }));
    expect(await screen.findByRole('dialog', { name: 'Write to Hornhoof developers' })).toBeInTheDocument();
  });

  it('speaks Russian', async () => {
    const { user } = page({}, 'ru');
    const box = await openFeedback(user, 'Аккаунт', 'Обратная связь', 'Написать разработчикам Hornhoof');
    expect(within(within(box).getByRole('group', { name: 'Что это' })).getAllByRole('button').map(b => b.textContent)).toEqual(['Ошибка', 'Улучшение', 'Идея']);
    await user.type(within(box).getByLabelText('Заголовок'), 'Терминал завис');
    await user.click(within(box).getByRole('button', { name: 'Далее' }));
    const check = await within(box).findByRole('region', { name: 'Это уйдет разработчикам Hornhoof' });
    expect(within(check).getByText('Версия Hornhoof')).toBeInTheDocument();
    expect(box.textContent!).not.toMatch(/[ё—]/);
  });
});
