/* A note at the foot of an agent's window (#1115). tone: quiet for what only tells, wait for what holds the agent
   back, bad for what was not done, access for a machine opened or asked for. alert: said at once to whoever hears the
   screen. link: the place where the note is answered. Its words are the screen's language, set apart from the page's
   direction so that a page drawn right to left keeps their order and their full stop at the end. */
export type NoteTone = 'quiet' | 'wait' | 'bad' | 'access';
export type NoteLink = { label: string; href: string; onOpen(): void };
export type WindowNote = { id: string; word: string; text: string; tone: NoteTone; alert?: boolean; link?: NoteLink };

function Note({ note }: { note: WindowNote }) {
  const { link } = note;
  return (
    <div className={`t-note ${note.tone}`} role={note.alert ? 'alert' : 'status'}>
      <span className="t-note-word" dir="ltr">
        {note.word}
      </span>{' '}
      <span className="t-note-text" dir="ltr">
        {note.text}
      </span>
      {link && (
        <>
          {' '}
          <a
            className="t-note-link"
            dir="ltr"
            href={link.href}
            onClick={e => {
              e.preventDefault();
              link.onOpen();
            }}
          >
            {link.label}
          </a>
        </>
      )}
    </div>
  );
}

/* Under the terminal and its input, never over them: the machine's memory in a column of its own on a wide window, and
   the other notes one under another beside it, or under it on a narrow one. Nothing to say, no foot. */
export function WindowFoot({ label, memory = null, notes }: { label: string; memory?: WindowNote | null; notes: WindowNote[] }) {
  if (!memory && !notes.length) return null;
  return (
    <div className={memory && notes.length ? 't-foot with-memory' : 't-foot'} role="group" aria-label={label}>
      {memory && <Note note={memory} />}
      {notes.length > 0 && (
        <div className="t-notes">
          {notes.map(note => (
            <Note key={note.id} note={note} />
          ))}
        </div>
      )}
    </div>
  );
}
