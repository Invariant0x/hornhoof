import type { ReactNode } from 'react';

/* The one way the product says something is under way, and the one way it says it stalled: a plan connecting after its
   sign-in code, a screen whose data is still coming. The mark's look is the style book's and stays here, so a screen says
   only what is under way and never draws a mark of its own. A person who asked for less motion sees it still. */

type WaitingProps = {
  /* What is under way now, in plain words. */
  what: ReactNode;
  /* More of it: how far it got, how long it has taken. */
  detail?: ReactNode;
};

export function Waiting({ what, detail }: WaitingProps) {
  return (
    <div className="uprog waiting" role="status">
      <span className="waiting-mark spinner" aria-hidden="true" />
      <b>{what}</b>
      {detail && <span className="uprog-text">{detail}</span>}
    </div>
  );
}

/* A way on from something stalled: its words, and the longer name a screen reader says when the words alone do not name
   what it is for. */
export type StalledAction = { text: string; label?: string; run(): unknown };

type StalledProps = {
  /* failed: it ended without its result; late: it took longer than its one limit and may still finish. */
  tone: 'failed' | 'late';
  /* Why, in plain words. */
  reason: ReactNode;
  /* What to do now. */
  next?: ReactNode;
  retry: StalledAction;
  /* Stops it, or puts away what it said, where there is a way to. */
  cancel?: StalledAction;
  /* What it had got to, when that helps. */
  children?: ReactNode;
};

/* Something that failed or took longer than its limit: why, what it got to, what to do, then Try again first. Never a mark
   that goes on turning. */
export function Stalled({ tone, reason, next, retry, cancel, children }: StalledProps) {
  return (
    <div className="stalled">
      <p className={tone === 'failed' ? 'alert' : 'warn-line'} role="alert">{reason}</p>
      {children}
      {next && <p>{next}</p>}
      <div className="machine-actions">
        <button className="btn" type="button" aria-label={retry.label} onClick={() => void retry.run()}>{retry.text}</button>
        {cancel && <button className="btn ghost" type="button" aria-label={cancel.label} onClick={() => void cancel.run()}>{cancel.text}</button>}
      </div>
    </div>
  );
}
