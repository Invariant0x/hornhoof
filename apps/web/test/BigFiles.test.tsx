import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { SentPictures } from '../src/ui/MessagePictures';
import { TaskFiles } from '../src/ui/TaskAttachments';

const AT = new Date().toISOString();
const SAID = 'big file: lives 30 days on one machine and is lost if that machine goes';

describe('a file over 50 MB', () => {
  it('says by its name, on the task and in the chat, that it lives 30 days on one machine and is lost if that machine goes', () => {
    render(
      <LanguageProvider>
        <TaskFiles files={[{ id: 'f1', name: 'dump.tar', size: 60 * 1024 * 1024, by: null, at: AT, big: true }, { id: 'f2', name: 'notes.txt', size: 10, by: null, at: AT }]} />
        <SentPictures data={{ pictures: [{ id: 'c1', name: 'archive.zip', file: true, big: true }, { id: 'c2', name: 'plan.pdf', file: true }] }} />
      </LanguageProvider>,
    );
    expect(screen.getByRole('link', { name: `dump.tar · ${SAID}` })).toHaveAttribute('href', '/api/attachments/f1');
    expect(screen.getByRole('link', { name: 'notes.txt' })).toHaveAttribute('href', '/api/attachments/f2');
    expect(screen.getByRole('link', { name: `Download archive.zip · ${SAID}` })).toHaveTextContent(`archive.zip · ${SAID}`);
    expect(screen.getByRole('link', { name: 'Download plan.pdf' })).toHaveTextContent(/^plan\.pdf$/);
  });
});
