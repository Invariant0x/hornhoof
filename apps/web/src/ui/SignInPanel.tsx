import { useEffect, useRef } from 'react';
import { SIGNIN_ERRORS, type SigninError } from '@hornhoof/protocol/signin';
import { useT, type Messages } from '../i18n';
import { useStream } from '../live';
import { AgentTerminal } from './AgentTerminal';

/* What a sign-in that did not finish says, in the person's language: its program's code and last line when it ended
   early and the machine gave one, otherwise the plain words of why. */
export function signInError(t: Messages, { error, code = null, line = null }: { error: string | null; code?: number | null; line?: string | null }): string {
  if (line) return t.subs.signInEnded(code, line);
  const key = (Object.keys(SIGNIN_ERRORS) as SigninError[]).find(k => SIGNIN_ERRORS[k] === error);
  return t.subs.signInErrors[key ?? 'other'];
}

type Props = {
  subId: string;
  program: string;
  nodeId: string;
  hostname: string;
  /* error: null when the plan signed in, else why it did not, in plain words. */
  onEnd(error: string | null): void;
  onStop(): void;
};

/* A plan's sign-in terminal on one of its owner's machines, which only the owner sees and types into. It closes when the
   machine says the sign-in finished or gave up. */
export function SignInPanel({ subId, program, nodeId, hostname, onEnd, onStop }: Props) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  /* It opens under the plan's card, often below the screen's edge: without this, pressing Sign in seems to do nothing. */
  useEffect(() => {
    box.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  useStream(m => {
    if (m.type !== 'subscription.signin' || m.subscriptionId !== subId || m.nodeId !== nodeId) return;
    onEnd(m.ok ? null : signInError(t, m));
  });
  return (
    <div className="signin" ref={box}>
      <h3>{t.subs.signingIn(hostname)}</h3>
      <p className="muted">{t.subs.signingInNote}</p>
      <AgentTerminal
        path={`/api/subscriptions/${subId}/signin/terminal?nodeId=${encodeURIComponent(nodeId)}`}
        program={program}
        onGone={() => onEnd(t.subs.signInErrors.other)}
      />
      <div className="actions">
        <button className="btn ghost" type="button" onClick={onStop}>{t.subs.stopSignIn}</button>
      </div>
    </div>
  );
}
