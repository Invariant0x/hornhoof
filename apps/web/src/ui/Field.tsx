import { useId, type ReactNode } from 'react';

type InputProps = { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean };

type Props = { label: string; hint?: string; problem?: string; children: (props: InputProps) => ReactNode };

/* A labelled control with an optional hint or problem line tied to it for screen readers. */
export function Field({ label, hint, problem, children }: Props) {
  const id = useId();
  const note = problem || hint;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, 'aria-describedby': note ? `${id}-note` : undefined, 'aria-invalid': problem ? true : undefined })}
      {note && <span id={`${id}-note`} className={problem ? 'bad' : 'hint'}>{note}</span>}
    </div>
  );
}
