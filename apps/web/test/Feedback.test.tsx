import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { About } from '../src/screens/About';
import { Feedback } from '../src/screens/Feedback';
import { Shell } from '../src/screens/Shell';
import { ME, mockApi, ORG } from './api-mock';
import { decl } from './css';

/* A person writes a bug, an improvement or an idea to Hornhoof's developers inside About: they see exactly what goes,
   with the technical data beside it, and nothing leaves until they press Send. */

const PERSON = { ...ME, person: { ...ME.person, scopeKind: 'listed' as const, isOwner: false } };
type Body = { kind: string; title: string; text: string; improvement?: string };
const FACTS = { version: '0.18.11', platform: ['darwin arm64', 'linux x64'], errorCode: null };

/* The server's preview: what it would send for what the window holds, as the server cleans it. */
const previewOf = (body: Body) => [
  200,
  {
    report: { kind: body.kind, title: body.title.replace('ivan@acme.example', '[email]'), text: body.text.replace(/ghp_\w+/, '[secret]').replace('/home/alex/shop', '[path]'), facts: FACTS },
    hidden: { secret: body.text.includes('ghp_') ? 1 : 0, email: body.title.includes('@') ? 1 : 0, address: 0, path: body.text.includes('/home/') ? 1 : 0 },
    digest: 'd'.repeat(64),
  },
] as [number, unknown];

function page(routes: Record<string, unknown> = {}, language = 'en') {
  localStorage.setItem('hh-lang', language);
  const calls = mockApi({
    'GET /api/org': [200, ORG],
    'GET /api/feedback': [200, { inbox: false }],
    'POST /api/feedback/preview': (body: unknown) => previewOf(body as Body),
    'POST /api/feedback': [200, { sent: true }],
    'GET /api/updates/current': [200, { version: '0.18.11', commit: 'abc1234' }],
    ...(routes as Record<string, [number, unknown]>),
  });
  render(<LanguageProvider><Shell me={PERSON} onSignOut={() => {}} /></LanguageProvider>);
  return { user: userEvent.setup(), calls };
}

/* About, with its feedback opened from its button. */
async function openFeedback(user: ReturnType<typeof userEvent.setup>, account = 'Account', item = 'About', title = 'About Hornhoof', write = 'Write to developers') {
  await user.click(screen.getByRole('button', { name: account }));
  await user.click(screen.getByRole('button', { name: item }));
  const box = await screen.findByRole('dialog', { name: title });
  await user.click(within(box).getByRole('button', { name: write }));
  return box;
}

const sent = (calls: ReturnType<typeof mockApi>) => calls.filter(c => c.method === 'POST' && c.path === '/api/feedback');

afterEach(() => localStorage.clear());

describe('writing to Hornhoof developers inside About', () => {
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
    await user.type(within(box).getByLabelText('What happened, or what you would like'), 'In /home/alex/shop the key ghp_abc123 showed');
    expect(within(box).getByText(/hides keys, passwords, email, addresses and home folder paths/)).toBeInTheDocument();
    await user.click(within(box).getByRole('button', { name: 'Next' }));

    const check = await within(box).findByRole('region', { name: 'This goes to Hornhoof developers' });
    expect(calls.filter(c => c.path === '/api/feedback/preview').map(c => c.body)).toEqual([{ kind: 'bug', title: 'Terminal froze for ivan@acme.example', text: 'In /home/alex/shop the key ghp_abc123 showed' }]);
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
    expect(sent(calls).map(c => c.body)).toEqual([{ kind: 'bug', title: 'Terminal froze for ivan@acme.example', text: 'In /home/alex/shop the key ghp_abc123 showed', digest: 'd'.repeat(64) }]);
    /* Done closes the feedback back to its button; About stays open. */
    await user.click(within(box).getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('dialog', { name: 'About Hornhoof' })).toBe(box);
    expect(within(box).getByRole('button', { name: 'Write to developers' })).toHaveFocus();
    expect(within(box).queryByText('Sent. Thank you, Hornhoof developers will read it.')).not.toBeInTheDocument();
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

  it('stands in About after its author and a line, with no Feedback item in the account menu and no window of its own', async () => {
    const { user } = page();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.queryByRole('button', { name: 'Feedback' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'About' }));
    const about = await screen.findByRole('dialog', { name: 'About Hornhoof' });
    const part = within(about).getByRole('region', { name: 'Feedback' });
    expect(part.previousElementSibling).toHaveClass('about-sep');
    await user.click(within(part).getByRole('button', { name: 'Write to developers' }));
    expect(within(part).getByRole('button', { name: 'Next' })).toBeInTheDocument();
    expect(within(part).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(location.pathname).toBe('/about');
  });

  it('marks an empty title invalid with its note tied to the field, keeps the draft, and clears the problem as soon as a title is typed', async () => {
    const { user, calls } = page();
    const box = await openFeedback(user);
    const title = within(box).getByLabelText('Title');
    const description = within(box).getByLabelText('What happened, or what you would like');
    expect(title).not.toHaveAttribute('aria-invalid');
    expect(title).not.toHaveAttribute('aria-describedby');

    await user.type(description, 'The map flickers when scrolling');
    await user.click(within(box).getByRole('button', { name: 'Next' }));
    const note = within(box).getByText('Write a title.');
    expect(note).toHaveClass('bad');
    expect(note.id).not.toBe('');
    expect(title).toHaveAttribute('aria-invalid', 'true');
    expect(title).toHaveAttribute('aria-describedby', note.id);
    expect(description).toHaveValue('The map flickers when scrolling');
    expect(description).not.toHaveAttribute('aria-invalid');
    expect(calls.filter(c => c.path === '/api/feedback/preview')).toEqual([]);

    await user.type(title, '   ');
    expect(within(box).getByText('Write a title.')).toBeInTheDocument();
    expect(title).toHaveAttribute('aria-invalid', 'true');

    await user.clear(title);
    await user.type(title, 'A');
    expect(within(box).queryByText('Write a title.')).not.toBeInTheDocument();
    expect(title).not.toHaveAttribute('aria-invalid');
    expect(title).not.toHaveAttribute('aria-describedby');
  });

  it('gives the title field of the form 44 px, as every field of the reference', () => {
    expect(decl('.fb-form .field input', 'height')).toBe('44px');
    expect(decl('.field :is(input, select, textarea)[aria-invalid="true"]', 'border-color')).toBe('var(--pink)');
  });

  it('keeps the focus where the person types in About when the screen behind it is drawn again', async () => {
    localStorage.setItem('hh-lang', 'en');
    mockApi({ 'GET /api/updates/current': [200, { version: '0.18.11', commit: 'abc1234' }] });
    const { rerender } = render(<LanguageProvider><About inbox={false} onClose={() => {}} /></LanguageProvider>);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Write to developers' }));
    await user.type(screen.getByLabelText('Title'), 'Terminal');
    rerender(<LanguageProvider><About inbox={false} onClose={() => {}} /></LanguageProvider>);
    await user.keyboard(' froze');
    expect(screen.getByLabelText('Title')).toHaveFocus();
    expect(screen.getByLabelText('Title')).toHaveValue('Terminal froze');
  });

  it('keeps the focus where the person types in the window of a finding when the screen behind it is drawn again', async () => {
    localStorage.setItem('hh-lang', 'en');
    const { rerender } = render(<LanguageProvider><Feedback inbox={false} onClose={() => {}} /></LanguageProvider>);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Title'), 'Terminal');
    rerender(<LanguageProvider><Feedback inbox={false} onClose={() => {}} /></LanguageProvider>);
    await user.keyboard(' froze');
    expect(screen.getByLabelText('Title')).toHaveFocus();
    expect(screen.getByLabelText('Title')).toHaveValue('Terminal froze');
  });

  it('speaks Russian', async () => {
    const { user } = page({}, 'ru');
    const box = await openFeedback(user, 'Аккаунт', 'О программе', 'О программе Hornhoof', 'Написать разработчикам');
    expect(within(box).getByRole('region', { name: 'Обратная связь' })).toBeInTheDocument();
    expect(within(within(box).getByRole('group', { name: 'Что это' })).getAllByRole('button').map(b => b.textContent)).toEqual(['Ошибка', 'Улучшение', 'Идея']);
    await user.type(within(box).getByLabelText('Заголовок'), 'Терминал завис');
    await user.click(within(box).getByRole('button', { name: 'Далее' }));
    const check = await within(box).findByRole('region', { name: 'Это уйдет разработчикам Hornhoof' });
    expect(within(check).getByText('Версия Hornhoof')).toBeInTheDocument();
    expect(box.textContent!).not.toMatch(/[ё—]/);
  });
});
