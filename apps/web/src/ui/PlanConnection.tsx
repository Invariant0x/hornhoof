import { useT, type Messages } from '../i18n';
import type { Connecting, SubView } from '../types';
import { signInError } from './SignInPanel';
import { subName, TERMINAL_SIGNIN } from './subscription';
import { Stalled, Waiting } from './Waiting';

/* The time since the code, in whole seconds, then minutes and seconds. */
export function passedWords(t: Messages, ms: number): string {
  const all = Math.max(0, Math.floor(ms / 1000));
  return all < 60 ? t.subs.connection.seconds(all) : t.subs.connection.minutes(Math.floor(all / 60), all % 60);
}

type Props = { sub: SubView; connecting: Connecting; now: number; onRetry(): unknown; onCancel(): unknown };

/* A plan's connection after its sign-in code, as its node says it: the step it is at and the time since the code until the
   plan is ready; why it failed and what to do; past its one limit, that it takes too long, with Try again and Stop. */
export function PlanConnection({ sub, connecting: c, now, onRetry, onCancel }: Props) {
  const t = useT();
  const words = t.subs.connection;
  const name = subName(t, sub);
  const step = words.steps[c.step];
  const passed = words.passed(passedWords(t, now - Date.parse(c.since)));
  const retry = { text: words.retry, label: words.retryLabel(name), run: onRetry };
  const cancel = { text: words.cancel, label: words.cancelLabel(name), run: onCancel };
  return (
    <div className="plan-connection" role="group" aria-label={words.label(name)}>
      {c.state === 'connecting' && <Waiting what={step} detail={passed} />}
      {c.state === 'failed' && (
        <Stalled tone="failed" reason={signInError(t, c)} next={TERMINAL_SIGNIN.has(sub.provider) ? words.next.signInAgain : words.next.installWindow(c.hostname)} retry={retry} cancel={cancel} />
      )}
      {c.state === 'too_long' && (
        <Stalled tone="late" reason={t.common.tooLong} next={words.tooLongNext(Math.round((Date.parse(c.until) - Date.parse(c.since)) / 60_000))} retry={retry} cancel={cancel}>
          <p className="muted">{step}. {passed}</p>
        </Stalled>
      )}
    </div>
  );
}
