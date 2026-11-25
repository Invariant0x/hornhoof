import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { SentPictures } from '../src/ui/MessagePictures';
import { TaskFiles } from '../src/ui/TaskAttachments';

const AT = new Date().toISOString();

describe('a file over 50 MB', () => {
  /* Every file is kept in the company's store on its machines, so a big one is shown as any other; a message from before
     the store may still say big of one, and nothing of it shows. */
  it('shows by its name alone, on the task and in the chat, as any other file', () => {
    const { container } = render(
      <LanguageProvider>
        <ul><TaskFiles files={[{ id: 'f1', name: 'dump.tar', size: 60 * 1024 * 1024, by: null, at: AT }, { id: 'f2', name: 'notes.txt', size: 10, by: null, at: AT }]} /></ul>
        <SentPictures data={{ pictures: [{ id: 'c1', name: 'archive.zip', file: true, big: true }, { id: 'c2', name: 'plan.pdf', file: true }] }} />
      </LanguageProvider>,
    );
    expect(screen.getByText('dump.tar')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open dump.tar' })).toHaveAttribute('href', '/api/attachments/f1');
    expect(screen.getByRole('link', { name: 'Open notes.txt' })).toHaveAttribute('href', '/api/attachments/f2');
    expect(screen.getByRole('link', { name: 'Download archive.zip' })).toHaveTextContent(/^archive\.zip$/);
    expect(screen.getByRole('link', { name: 'Download plan.pdf' })).toHaveTextContent(/^plan\.pdf$/);
    expect(container.textContent).not.toMatch(/one machine/);
  });
});
