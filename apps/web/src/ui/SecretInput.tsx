import type { InputHTMLAttributes, Ref } from 'react';

/* The marks by which 1Password, LastPass, Bitwarden and Dashlane each leave a field alone: no saved login goes into it. */
export const NOT_A_LOGIN = { 'data-1p-ignore': 'true', 'data-lpignore': 'true', 'data-bwignore': 'true', 'data-form-type': 'other' } as const;

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'autoComplete'> & { ref?: Ref<HTMLInputElement>; shown?: boolean };

/* A key, token or password for somewhere other than Hornhoof. A browser and a password manager put Hornhoof's own saved
   sign-in into a form with a password field, and offer to save what is typed there as that sign-in, so this is never
   one: a text field the screen masks, which nothing fills and nothing saves (#1320). shown: the person asked to see what
   they type. */
export function SecretInput({ shown = false, className, ref, ...props }: Props) {
  const classes = [className, shown ? null : 'secret-masked'].filter(Boolean).join(' ');
  return <input {...props} {...NOT_A_LOGIN} ref={ref} type="text" className={classes || undefined} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} />;
}
