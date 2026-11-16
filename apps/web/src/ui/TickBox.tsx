import type { ComponentPropsWithRef } from 'react';

/* A box to tick drawn by us, so it is the same in every browser: the input stays the browser's for the keyboard and for
   readers, its frame and tick are ours. Its name comes from the label it stands in. */
export function TickBox(props: Omit<ComponentPropsWithRef<'input'>, 'type'>) {
  return (
    <span className="tick-box">
      <input {...props} type="checkbox" />
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 8.5l3 3 6-7" /></svg>
    </span>
  );
}
