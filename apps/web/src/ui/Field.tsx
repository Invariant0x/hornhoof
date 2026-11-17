import { useId, type ReactNode } from 'react';

export type InputProps = { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean };

type Props = { label: string; hint?: ReactNode; problem?: string; children: (props: InputProps) => ReactNode };

/* A labelled control with an optional hint or problem line tied to it for screen readers. The control and its line stand
   together, so a form's grid can put the label in a column of its own beside them. The line is a sentence in its own
   direction, so right to left its full stop stays at its end. */
export function Field({ label, hint, problem, children }: Props) {
  const id = useId();
  const note = problem || hint;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="field-control">
        {children({ id, 'aria-describedby': note ? `${id}-note` : undefined, 'aria-invalid': problem ? true : undefined })}
        {note && <span id={`${id}-note`} className={problem ? 'bad' : 'hint'} dir="auto">{note}</span>}
      </div>
    </div>
  );
}
