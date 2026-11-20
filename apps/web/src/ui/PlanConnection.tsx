import { SIGNIN_ERRORS } from '@hornhoof/protocol/signin';
import { useT, type Messages } from '../i18n';
import { PROGRAM_NAMES } from '../providers';
import type { Connecting, SubView } from '../types';
import { isKeyPlan } from './KeyForm';
import { LoadFail, type Load } from './Loading';
import { signInError } from './SignInPanel';
import { subName, TERMINAL_SIGNIN } from './subscription';

/* The time since the code, in whole seconds, then minutes and seconds. */
export function passedWords(t: Messages, ms: number): string {
  const all = Math.max(0, Math.floor(ms / 1000));
  return all < 60 ? t.subs.connection.seconds(all) : t.subs.connection.minutes(Math.floor(all / 60), all % 60);
}

/* Where a plan's connection after its sign-in code stands among the steps of its way to work: the third of four, its sign-in,
   or its key for a plan that takes one. */
const AT = 2;

type Props = { sub: SubView; connecting: Connecting; now: number; onRetry(): unknown; onCancel(): unknown };

/* A step of the plan's way to work: done ones ticked, the one Hornhoof works on with the ring in its marker, or its number in
   pink once it did not work, the later ones dimmed. Steps that wait for the person are behind it, with no ring and no
   time. */
function ConnectStep({ i, title, failed }: { i: number; title: string; failed: boolean }) {
  const words = useT().subs.steps;
  const state = i < AT ? 'done' : i > AT ? 'next' : failed ? 'bad' : 'now';
  const said = { done: words.done, now: words.current, bad: words.failedMark, next: null }[state];
  return (
    <li className={state} aria-current={i === AT ? 'step' : undefined}>
      <span className="conn-mk" aria-hidden="true">{state === 'done' ? '✓' : state === 'now' ? <span className="spinner" /> : i + 1}</span>
      <span>{title}{said && <span className="sr"> {said}</span>}</span>
    </li>
  );
}

/* How far the plan got: "Step 3 of 4" over a bar of the steps done, then the steps. */
function ConnectSteps({ sub, failed }: { sub: SubView; failed: boolean }) {
  const t = useT();
  const words = t.subs.steps;
  const program = PROGRAM_NAMES[sub.provider];
  const titles = [words.run, words.connect, isKeyPlan(sub.provider) ? words.key(program) : words.signIn(program), words.ready];
  const label = words.label(subName(t, sub));
  return (
    <>
      <div className="conn-prog">
        <p>{t.subs.connection.progress(AT + 1, titles.length)}</p>
        <span className="bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={titles.length} aria-valuenow={AT}><i style={{ inlineSize: `${(AT * 100) / titles.length}%` }} /></span>
      </div>
      <ol className="conn-steps" aria-label={label}>
        {titles.map((title, i) => <ConnectStep key={i} i={i} title={title} failed={failed} />)}
      </ol>
    </>
  );
}

/* What to do after a failure: check the machine, which stopped answering; sign in again from Hornhoof; or, for a program that
   signs in on its machine, the install window there. */
function nextAfter(t: Messages, sub: SubView, c: Connecting): string {
  const next = t.subs.connection.next;
  if (c.error === SIGNIN_ERRORS.noAnswer) return next.noAnswer;
  return TERMINAL_SIGNIN.has(sub.provider) ? next.signInAgain : next.installWindow(c.hostname);
}

/* What happens now: the step its node reports and the time since the code, as the screen's status; past a minute with no new
   step, that it takes longer than usual; or why it failed and what to do. Retry and Stop for both. */
function ConnectNow({ sub, connecting: c, now, onRetry, onCancel }: Props) {
  const t = useT();
  const words = t.subs.connection;
  const name = subName(t, sub);
  const at = `${words.steps[c.step]}. ${words.passed(passedWords(t, now - Date.parse(c.since)))}`;
  if (c.state === 'connecting') return <><p role="status">{at}</p><p className="conn-keep">{words.keepOn}</p></>;
  const load: Load = { phase: c.state === 'too_long' ? 'slow' : 'failed', ring: false, failure: null, asked: 0, retry: onRetry };
  return (
    <>
      {c.state === 'too_long' && <p>{at}</p>}
      <LoadFail load={load} onRetry={onRetry} retryLabel={words.retryLabel(name)} words={[signInError(t, c), nextAfter(t, sub, c)]} slowHint={words.slowHint} ring={false}
        stop={{ text: words.cancel, label: words.cancelLabel(name), run: onCancel }} />
    </>
  );
}

/* A plan's connection after its sign-in code, as its node says it (style book 1.5, section 4): its steps with the ring on the
   one Hornhoof works on, then what happens now, until the plan is ready. The server alone keeps its times: a minute with no
   new step is longer than usual, and its deadline fails it. */
export function PlanConnection(props: Props) {
  const t = useT();
  return (
    <div className="plan-connection" role="group" aria-label={t.subs.connection.label(subName(t, props.sub))}>
      <ConnectSteps sub={props.sub} failed={props.connecting.state === 'failed'} />
      <div className="conn-now">
        <h4 className="part-h">{t.subs.connection.nowTitle}</h4>
        <ConnectNow {...props} />
      </div>
    </div>
  );
}
