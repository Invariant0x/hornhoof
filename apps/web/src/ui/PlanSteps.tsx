import { useT, type Messages } from '../i18n';
import { PROGRAM_NAMES } from '../providers';
import type { ShownCommand, SubView } from '../types';
import { commandStepText, type CommandStepContent } from './CommandBox';
import { isKeyPlan } from './KeyForm';
import { subName, TERMINAL_SIGNIN } from './subscription';

/* Where a personal plan is on its way to work, from what the page has: no machine yet, a machine that joined but is not
   online, an online one that waits for the sign-in or the first setup. A key needs no machine and a ready plan has no step
   left, so neither has one. */
function planStep(s: SubView): number | null {
  if (s.kind !== 'personal' || s.status === 'ready') return null;
  if (s.status === 'waiting_machine') return 0;
  return s.machines.some(m => m.online && m.status === s.status) ? 2 : 1;
}

/* How the plan signs in on an online machine now: the terms its program asks to accept there, its key, the terminal from
   Hornhoof, or the install window for a program Hornhoof does not sign in. */
function signInNow(t: Messages, s: SubView, signing: boolean): string {
  const program = PROGRAM_NAMES[s.provider];
  const there = s.machines.find(m => m.online && m.status === s.status)?.hostname ?? '';
  const now = t.subs.steps.now;
  if (s.status === 'needs_setup') return now.setup(program, there);
  if (isKeyPlan(s.provider)) return now.key(program);
  if (!TERMINAL_SIGNIN.has(s.provider)) return now.installWindow(program, there);
  return signing ? now.signing(program) : now.signIn(program);
}

/* command: null when the plan has none that still works, so its owner makes a new one; signing: its terminal is open. */
type Props = { sub: SubView; command?: ShownCommand | null; signing?: boolean; install?: CommandStepContent };

/* The steps from adding a personal plan to agents working on it, for its owner: the passed ones ticked, the current one with
   what to do now, the later ones dimmed. */
export function PlanSteps({ sub: s, command, signing = false, install }: Props) {
  const t = useT();
  const at = planStep(s);
  if (at === null) return install?.body ?? null;
  const words = t.subs.steps;
  const program = PROGRAM_NAMES[s.provider];
  const titles = [words.run, words.connect, isKeyPlan(s.provider) ? words.key(program) : words.signIn(program), words.ready];
  const first = command === null ? words.now.newCommand : commandStepText(t, install?.state, words.now.run);
  const now = [first, words.now.connect, signInNow(t, s, signing)][at];
  return (
    <>
      <ol className="plan-steps" role="list" aria-label={words.label(subName(t, s))}>
        {titles.map((title, i) => (
          <li key={i} className={i < at ? 'done' : i === at ? 'now' : 'next'} aria-current={i === at ? 'step' : undefined}>
            <span>{title}</span>
            {i < at && <span className="sr"> {words.done}</span>}
            {i === at && now && <p>{now}</p>}
            {i === 0 && at === 0 && install?.body}
          </li>
        ))}
      </ol>
      {at !== 0 && install?.body}
    </>
  );
}
