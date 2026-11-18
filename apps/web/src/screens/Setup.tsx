import { useId, useState, type FormEvent } from 'react';
import { api, ApiFailure } from '../api';
import { errorText, useT, type Messages } from '../i18n';
import { PLAN_PROVIDERS, PROVIDER_NAMES, type PlanProvider } from '../providers';
import { Card } from '../ui/Card';
import { CommandBox } from '../ui/CommandBox';
import { CompanyTemplates, type Pick } from '../ui/CompanyTemplates';
import { Field } from '../ui/Field';
import { blocks, LinkName, type NameCheck, type NameState } from '../ui/LinkName';
import { LinkReady, type MadeLink } from '../ui/LinkReady';
import { NOT_A_LOGIN, SecretInput } from '../ui/SecretInput';
import { RestoreFromFile } from './RestoreFromFile';

type Mode = 'api_key' | 'personal' | 'later';
type KeyProvider = 'anthropic_api' | 'openai_api';
type Problems = Record<string, string>;

const MODES: Mode[] = ['api_key', 'personal', 'later'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* The setup link the server logs carries the code that lets this browser create the company. */
const linkCode = () => new URLSearchParams(window.location.search).get('code')?.trim() ?? '';

const LINK_REFUSED = new Set(['link_taken', 'link_reserved', 'link_invalid']);

/* Everything the person writes or picks over the three steps. */
interface Form {
  code: string;
  companyName: string;
  /* The ready-made company the CEO starts from, or "empty" to let the orchestrator build it. */
  template: Pick;
  /* The public link: on unless the person turns it off, starting on a long random name. */
  linkOn: boolean;
  linkName: string;
  name: string;
  title: string;
  email: string;
  password: string;
  mode: Mode;
  keyProvider: KeyProvider;
  apiKey: string;
  plan: PlanProvider;
}

type Update = (patch: Partial<Form>) => void;

const startForm = (): Form => ({
  code: linkCode(),
  companyName: '',
  template: 'empty',
  linkOn: true,
  linkName: '',
  name: '',
  title: 'CEO',
  email: '',
  password: '',
  mode: 'api_key',
  keyProvider: 'anthropic_api',
  apiKey: '',
  plan: 'claude',
});

function useForm(): [Form, Update] {
  const [form, setForm] = useState(startForm);
  return [form, patch => setForm(was => ({ ...was, ...patch }))];
}

/* What is wrong with the account step, by field. */
function accountProblems(t: Messages, form: Form): Problems {
  const found: Problems = {};
  if (!EMAIL.test(form.email.trim())) found.email = t.setup.emailProblem;
  if (form.password.length < 10) found.password = t.common.useAtLeast10;
  return found;
}

/* What is wrong with the step the person leaves; the company step has nothing to check here. */
const problemsAt = (step: number, t: Messages, form: Form): Problems => (step === 1 ? accountProblems(t, form) : {});

const apiKeyProblem = (t: Messages, form: Form): Problems | null =>
  form.mode === 'api_key' && form.apiKey.trim().length < 8 ? { apiKey: t.setup.pasteWholeKey } : null;

function orchestratorOf(form: Form) {
  if (form.mode === 'api_key') return { mode: form.mode, provider: form.keyProvider, apiKey: form.apiKey.trim() };
  return form.mode === 'personal' ? { mode: form.mode, provider: form.plan } : { mode: form.mode };
}

function setupBody(form: Form) {
  return {
    code: form.code.trim(),
    companyName: form.companyName.trim(),
    name: form.name.trim(),
    email: form.email.trim(),
    password: form.password,
    title: form.title.trim(),
    orchestrator: orchestratorOf(form),
    ...(form.linkOn ? { link: { name: form.linkName } } : {}),
    ...(form.template === 'empty' ? {} : { template: form.template }),
  };
}

/* Where a refused setup goes back to: the setup code, the link's name, or the last step with the message. */
type Refusal = { where: 'code' | 'link' | 'form'; text: string; skipLink: boolean };

function refusalOf(t: Messages, err: unknown): Refusal {
  const reason = err instanceof ApiFailure ? err.reason : undefined;
  const text = errorText(t, err);
  if (reason === 'setup_code') return { where: 'code', text, skipLink: false };
  if (reason && LINK_REFUSED.has(reason)) return { where: 'link', text, skipLink: false };
  return { where: 'form', text, skipLink: reason === 'relay_unreachable' };
}

type SetupAnswer = { command?: string; link?: MadeLink };

/* Sends the setup, and keeps what the last try said: busy, or the message of a refusal that stays on the last step. */
function useSubmit(form: Form, onAnswer: (answer: SetupAnswer) => void, onRefused: (refusal: Refusal) => void) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [skipLink, setSkipLink] = useState(false);

  async function submit() {
    setBusy(true);
    setFailure('');
    setSkipLink(false);
    try {
      onAnswer(await api.post<SetupAnswer>('/api/setup', setupBody(form)));
    } catch (err) {
      const refusal = refusalOf(t, err);
      if (refusal.where !== 'form') onRefused(refusal);
      else {
        setFailure(refusal.text);
        setSkipLink(refusal.skipLink);
      }
    } finally {
      setBusy(false);
    }
  }
  return { busy, failure, skipLink, submit };
}

/* What follows a setup that went through: a link made waits for its certificate, a node command waits to be run, else the
   person is done. The plan is kept for the command's words. */
function useAfterSetup(onDone: (done: { welcome: boolean }) => void) {
  const [command, setCommand] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanProvider>('claude');
  const [made, setMade] = useState<MadeLink | null>(null);
  /* The password the person just chose, kept for the one command this screen still shows: their key is made with it. */
  const [password, setPassword] = useState('');
  const done = () => onDone({ welcome: true });
  return {
    command,
    plan,
    made,
    password,
    answer(answer: SetupAnswer, chosen: PlanProvider, typed: string) {
      setCommand(answer.command ?? null);
      setPlan(chosen);
      setPassword(typed);
      if (answer.link) setMade(answer.link);
      else if (!answer.command) done();
    },
    goOn() {
      setMade(null);
      if (!command) done();
    },
    done,
  };
}

interface StepProps {
  form: Form;
  update: Update;
  problems: Problems;
}

interface PublicLinkProps extends StepProps {
  domain: string;
  onState: (state: NameState) => void;
  onNameTyped: () => void;
}

/* The choice to open Hornhoof on the internet, and the name of the link. */
function PublicLinkChoice({ form, update, problems, domain, onState, onNameTyped }: PublicLinkProps) {
  const t = useT();
  const uid = useId();
  const checkName = (name: string) => api.get<NameCheck>(`/api/setup/names/${encodeURIComponent(name)}?code=${encodeURIComponent(form.code.trim())}`);
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={form.linkOn} onChange={e => update({ linkOn: e.target.checked })} aria-labelledby={`${uid}-link`} aria-describedby={`${uid}-link-hint`} />
        <span>
          <b id={`${uid}-link`}>{t.link.open}</b>
          <small id={`${uid}-link-hint`}>{t.link.openHint}</small>
        </span>
      </label>
      {form.linkOn && (
        <LinkName
          name={form.linkName}
          onName={linkName => {
            update({ linkName });
            onNameTyped();
          }}
          domain={domain}
          check={checkName}
          onState={onState}
          problem={problems.link}
          startRandom
        />
      )}
    </>
  );
}

/* The company step cannot go on without a name, a setup code if one is asked, and a link name that works. */
const companyStepBlocked = (form: Form, askCode: boolean, linkState: NameState, problems: Problems): boolean =>
  !form.companyName.trim() || (askCode && !form.code.trim()) || (form.linkOn && (blocks(linkState) || !!problems.link));

interface CompanyStepProps extends StepProps {
  askCode: boolean;
  linkDomain: string;
  onNameTyped: () => void;
  onNext: (e: FormEvent) => void;
}

function CompanyStep({ form, update, problems, askCode, linkDomain, onNameTyped, onNext }: CompanyStepProps) {
  const t = useT();
  const [linkState, setLinkState] = useState<NameState>('empty');
  return (
    <form onSubmit={onNext}>
      <div className="setup-lead">
        <Field label={t.setup.companyName}>
          {p => <input {...p} value={form.companyName} onChange={e => update({ companyName: e.target.value })} maxLength={80} autoFocus autoComplete="organization" />}
        </Field>
      </div>
      <CompanyTemplates value={form.template} onPick={template => update({ template })} />
      <div className="setup-lead">
        <PublicLinkChoice form={form} update={update} problems={problems} domain={linkDomain} onState={setLinkState} onNameTyped={onNameTyped} />
        {askCode && (
          <Field label={t.setup.code} problem={problems.code} hint={t.setup.codeHint}>
            {p => <input {...p} {...NOT_A_LOGIN} value={form.code} onChange={e => update({ code: e.target.value })} maxLength={200} autoComplete="off" spellCheck={false} />}
          </Field>
        )}
      </div>
      <div className="actions">
        <button className="btn" type="submit" disabled={companyStepBlocked(form, askCode, linkState, problems)}>{t.common.next}</button>
      </div>
    </form>
  );
}

interface AccountStepProps extends StepProps {
  onBack: () => void;
  onNext: (e: FormEvent) => void;
}

function AccountStep({ form, update, problems, onBack, onNext }: AccountStepProps) {
  const t = useT();
  return (
    <form onSubmit={onNext} noValidate>
      <p className="muted">{t.setup.becomeCeo(form.companyName.trim())}</p>
      <Field label={t.setup.yourName}>
        {p => <input {...p} value={form.name} onChange={e => update({ name: e.target.value })} maxLength={80} autoFocus autoComplete="name" />}
      </Field>
      <Field label={t.setup.yourTitle}>
        {p => <input {...p} value={form.title} onChange={e => update({ title: e.target.value })} maxLength={80} autoComplete="organization-title" />}
      </Field>
      <Field label={t.common.email} problem={problems.email}>
        {p => <input {...p} type="email" value={form.email} onChange={e => update({ email: e.target.value })} autoComplete="username" />}
      </Field>
      <Field label={t.common.password} problem={problems.password} hint={t.common.atLeast10}>
        {p => <input {...p} type="password" value={form.password} onChange={e => update({ password: e.target.value })} autoComplete="new-password" />}
      </Field>
      <div className="actions">
        <button className="btn ghost" type="button" onClick={onBack}>{t.common.back}</button>
        <button className="btn" type="submit" disabled={!form.name.trim() || !form.email.trim() || !form.password}>{t.common.next}</button>
      </div>
    </form>
  );
}

/* How the orchestrator runs: with an API key, with the person's own plan, or later. */
function ModeChoice({ mode, onMode }: { mode: Mode; onMode: (mode: Mode) => void }) {
  const t = useT();
  const uid = useId();
  return (
    <fieldset className="choice">
      <legend className="sr">{t.setup.howOrchestratorRuns}</legend>
      {MODES.map(id => (
        <label key={id} className={mode === id ? 'on' : ''}>
          <input type="radio" name="mode" value={id} checked={mode === id} onChange={() => onMode(id)} aria-labelledby={`${uid}-${id}`} aria-describedby={`${uid}-${id}-hint`} />
          <b id={`${uid}-${id}`}>{t.setup.modes[id].label}</b>
          <span id={`${uid}-${id}-hint`}>{t.setup.modes[id].hint}</span>
        </label>
      ))}
    </fieldset>
  );
}

function KeyFields({ form, update, problems }: StepProps) {
  const t = useT();
  return (
    <>
      <Field label={t.setup.provider}>
        {p => (
          <select {...p} value={form.keyProvider} onChange={e => update({ keyProvider: e.target.value as KeyProvider })}>
            <option value="anthropic_api">Anthropic</option>
            <option value="openai_api">OpenAI</option>
          </select>
        )}
      </Field>
      <Field label={t.setup.key} problem={problems.apiKey}>
        {p => <SecretInput {...p} value={form.apiKey} onChange={e => update({ apiKey: e.target.value })} />}
      </Field>
    </>
  );
}

function PlanChoice({ plan, onPlan }: { plan: PlanProvider; onPlan: (plan: PlanProvider) => void }) {
  const t = useT();
  return (
    <fieldset className="segments">
      <legend className="sr">{t.setup.subscription}</legend>
      {PLAN_PROVIDERS.map(id => (
        <label key={id} className={plan === id ? 'on' : ''}>
          <input type="radio" name="plan" value={id} checked={plan === id} onChange={() => onPlan(id)} />
          {PROVIDER_NAMES[id]}
        </label>
      ))}
    </fieldset>
  );
}

interface OrchestratorStepProps extends StepProps {
  busy: boolean;
  failure: string;
  skipLink: boolean;
  onBack: () => void;
  onFinish: (e: FormEvent) => void;
}

function OrchestratorStep({ form, update, problems, busy, failure, skipLink, onBack, onFinish }: OrchestratorStepProps) {
  const t = useT();
  return (
    <form onSubmit={onFinish} noValidate>
      <p className="muted">{t.setup.orchestratorIntro}</p>
      <ModeChoice mode={form.mode} onMode={mode => update({ mode })} />
      {form.mode === 'api_key' && <KeyFields form={form} update={update} problems={problems} />}
      {form.mode === 'personal' && <PlanChoice plan={form.plan} onPlan={plan => update({ plan })} />}
      {failure && <p className="alert" role="alert">{failure}</p>}
      {failure && skipLink && <p className="muted">{t.link.skipHint}</p>}
      <div className="actions">
        <button className="btn ghost" type="button" onClick={onBack}>{t.common.back}</button>
        <button className="btn" type="submit" disabled={busy}>{t.setup.finish}</button>
      </div>
    </form>
  );
}

/* The three steps, one at a time. */
function StepBody({ step, ...props }: { step: number } & CompanyStepProps & OrchestratorStepProps) {
  if (step === 0) return <CompanyStep {...props} />;
  if (step === 1) return <AccountStep {...props} />;
  return <OrchestratorStep {...props} />;
}

function StepsHead({ step }: { step: number }) {
  const t = useT();
  const steps = t.setup.steps;
  return (
    <div className="wizard-head">
      <p className="muted">{t.setup.heading}</p>
      <ol className="steps" aria-label={t.setup.stepOf(step + 1, steps.length)}>
        {steps.map((title, i) => (
          <li key={title} className={i <= step ? 'on' : ''} aria-current={i === step ? 'step' : undefined}>
            <span className="sr">{title}</span>
          </li>
        ))}
      </ol>
      <h1>{steps[step]}</h1>
    </div>
  );
}

interface WizardProps {
  linkDomain: string;
  onAnswer: (answer: SetupAnswer, plan: PlanProvider, password: string) => void;
  /* Instead of a new company: bring back one whose server was lost. */
  onRestore: () => void;
}

/* The three steps of setup, with what the person has written kept while they go back and forth. */
function Wizard({ linkDomain, onAnswer, onRestore }: WizardProps) {
  const t = useT();
  const [form, update] = useForm();
  const [step, setStep] = useState(0);
  const [askCode, setAskCode] = useState(() => !linkCode());
  const [problems, setProblems] = useState<Problems>({});
  const sent = useSubmit(
    form,
    answer => onAnswer(answer, form.plan, form.password),
    refusal => {
      setProblems({ [refusal.where]: refusal.text });
      setAskCode(was => was || refusal.where === 'code');
      setStep(0);
    },
  );

  function next(e: FormEvent) {
    e.preventDefault();
    const found = problemsAt(step, t, form);
    setProblems(found);
    if (!Object.keys(found).length) setStep(step + 1);
  }

  function finish(e: FormEvent) {
    e.preventDefault();
    const missing = apiKeyProblem(t, form);
    if (missing) setProblems(missing);
    else void sent.submit();
  }

  return (
    <Card wide={step === 0}>
      <StepsHead step={step} />
      <StepBody
        step={step}
        form={form}
        update={update}
        problems={problems}
        askCode={askCode}
        linkDomain={linkDomain}
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omit the cleared link problem
        onNameTyped={() => setProblems(({ link: _, ...rest }) => rest)}
        onNext={next}
        {...sent}
        onBack={() => setStep(step - 1)}
        onFinish={finish}
      />
      {step === 0 && <div className="actions"><button className="btn ghost" type="button" onClick={onRestore}>{t.setup.restore.link}</button></div>}
    </Card>
  );
}

/* The command that connects the person's own machine, shown when the orchestrator runs on their plan. */
/* The password is the one the person just chose in this form, so their key is made with it and nothing more is asked. */
function ConnectMachine({ command, plan, password, onDone }: { command: string; plan: PlanProvider; password: string; onDone: () => void }) {
  const t = useT();
  return (
    <Card>
      <h1>{t.setup.connectMachine}</h1>
      <p className="muted">{t.setup.runThis(PROVIDER_NAMES[plan])}</p>
      <CommandBox command={command} password={password} />
      <p className="muted">{t.setup.joinOnce}</p>
      <div className="actions">
        <button className="btn" type="button" onClick={onDone}>{t.setup.goToMap}</button>
      </div>
    </Card>
  );
}

/* linkDomain: what public links end in, as the server says. */
export function Setup({ onDone, linkDomain = 'hornhoof.org', recovering = false }: { onDone: (done: { welcome: boolean }) => void; linkDomain?: string; recovering?: boolean }) {
  const t = useT();
  const after = useAfterSetup(onDone);
  /* The server was given a recovery file already, or the person chose to give it one. */
  const [restoring, setRestoring] = useState(recovering);
  if (after.made) {
    return (
      <Card>
        <h1>{t.settings.link}</h1>
        <LinkReady link={after.made} onNext={after.goOn} />
      </Card>
    );
  }
  if (after.command) return <ConnectMachine password={after.password} command={after.command} plan={after.plan} onDone={after.done} />;
  if (restoring) return <Card><RestoreFromFile code={linkCode()} recovering={recovering} onBack={() => setRestoring(false)} /></Card>;
  return <Wizard linkDomain={linkDomain} onAnswer={after.answer} onRestore={() => setRestoring(true)} />;
}
