import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { errorText, useT } from '../i18n';
import { BusyLabel } from './BusyLabel';
import { takeEscape } from './escape';

/* The one question a person answers before a critical action of theirs: the action named in the question, what happens
   and to what, then the action's own verb or Cancel (style book 1.9, section 4 "Confirmation"; #1795, #1807).

   RULE. Every critical action a person takes in the interface goes through this window: removing or deleting, renaming,
   disconnecting, revoking access, moving the server, and anything else hard to undo. A new one does too. The API and
   agents keep their own way and their own rights; the window is for people in the interface only.

   The actions that go through it now (1807-confirmation-inventory.md on #1807):
   - People: delete a person or an assistant, rename a person or an assistant, change one's own name, disable a person,
     change their access or CEO deputy authority (screens/People.tsx, screens/PeopleAssistant.tsx, screens/Settings.tsx).
   - Employees: remove one, reset its instructions, disconnect its plan (ui/AgentCard.tsx); stop current work in its
     window (screens/AgentWindow.tsx).
   - Departments: remove a department or product, or change sub-units through a structure proposal (ui/StructureCard.tsx);
     rename or delete a sub-unit (ui/SubUnits.tsx).
   - Machines: disconnect one, move the company server or stop a move, change where backups are kept (screens/Machines.tsx);
     open or close computer access (ui/MachineAccessBlock.tsx); update a machine's programs (ui/ProgramVersions.tsx); remove
     a machine (#1796) and a former server (#1808).
   - Plans: remove a plan or API key, move the orchestrator to another plan (screens/Subscriptions.tsx); replace a saved key
     (ui/KeyForm.tsx); change an API plan's label or target (ui/ApiForm.tsx); remove a fallback plan (ui/PlanFallbacks.tsx);
     stop lending a phone (ui/Phones.tsx).
   - Copies of the company: restore a backup or leave a kept database out (screens/Backups.tsx); restore on a replacement
     server (screens/RestoreFromFile.tsx); choose the copy to go on from (ui/RecoveryQuestion.tsx); update the server now
     (ui/UpdateBanner.tsx, screens/Versions.tsx).
   - Work: cancel a task (ui/TaskPanel.tsx, ui/Requests.tsx); pause a task (ui/TaskPanel.tsx); remove a pipeline stage
     (ui/TrackerForms.tsx); delete a backlog item (ui/Backlog.tsx) or a note (ui/Notebook.tsx); hide a secret
     (ui/HideSecret.tsx); apply a merge decision (ui/MergeCard.tsx).
   - Settings: change a department's owner, approval rules or autonomous release (ui/ApprovalPolicy.tsx); remove or replace a
     repository connection or host key (ui/RepoSettings.tsx, ui/RepoHost.tsx); remove or change the public link
     (screens/Settings.tsx); remove a vault entry or replace its secret (ui/Vault.tsx); revoke or replace an assistant's key
     (screens/PeopleAssistant.tsx); disconnect Google Sheets (ui/GoogleSheets.tsx) or a Telegram bot (ui/TelegramBot.tsx).

   The caller renders it while the question is open, or asks through useConfirmAction. Cancel, Escape and a click on the
   dim layer close it and change nothing. The action button runs onYes once: while it runs both buttons wait and Escape
   is held; a failure it throws stays in the window with the buttons back, and success closes it. Focus opens on Cancel
   for a dangerous action and on the action otherwise, stays inside the window, and goes back to the button that opened
   it. The window is a modal dialog in the top layer, so the page under it takes no clicks, keys or reading. */
export type ConfirmActionProps = {
  /* The question that names the action: "Do you really want to remove this employee?" */
  title: string;
  /* What happens and to what, one line; a name in it stands in <bdi>. */
  effect: ReactNode;
  /* More the person must know first, each a line of its own, such as a last copy of data. */
  warnings?: readonly ReactNode[];
  /* The action cannot be undone. */
  final?: boolean;
  /* The action's verb on its button: "Remove", "Rename". */
  yes: string;
  /* What the button says while the action runs. */
  working?: string;
  /* Removing, disconnecting, taking back access or what cannot be undone. */
  danger?: boolean;
  onYes: () => unknown;
  onClose: () => void;
};

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/* The window's own events stay in it: a row or a panel it was opened from never takes its clicks or keys. */
const keepIn = (event: SyntheticEvent) => event.stopPropagation();

function nextFocusStop(stops: readonly HTMLElement[], at: Element | null, inside: boolean, shift: boolean): HTMLElement | null {
  const edge = shift ? stops[0] : stops[stops.length - 1];
  if (inside && at !== edge) return null;
  return shift ? stops[stops.length - 1]! : stops[0]!;
}

/* Tab and Shift+Tab go round the window's own buttons. */
function trapDialogFocus(event: ReactKeyboardEvent<HTMLDialogElement>, container: HTMLDivElement | null): void {
  event.stopPropagation();
  if (event.key !== 'Tab' || !container) return;
  const stops = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (!stops.length) return event.preventDefault();
  const next = nextFocusStop(stops, document.activeElement, container.contains(document.activeElement), event.shiftKey);
  if (!next) return;
  event.preventDefault();
  next.focus();
}

/* Opens the modal in the top layer once, sets its initial focus and restores the opener on close. */
function useModalDialog(back: RefObject<HTMLDialogElement | null>, firstFocus: RefObject<RefObject<HTMLButtonElement | null>>, live: RefObject<boolean>) {
  useLayoutEffect(() => {
    const dialog = back.current!;
    const opener = document.activeElement;
    live.current = true;
    if (!dialog.open) dialog.showModal();
    firstFocus.current.current?.focus();
    return () => {
      live.current = false;
      if (dialog.open) dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [back, firstFocus, live]);
}

/* On the window object, ahead of every listener on the document, so a window under this one keeps its own Escape and
   an employee window does not stop its work. */
function useEscapeDismiss(dismiss: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!takeEscape(event)) return;
      event.stopPropagation();
      dismiss();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dismiss]);
}

type SubmitDone = { ok: true } | { ok: false; err: unknown };

async function runAction(onYes: () => unknown): Promise<SubmitDone> {
  try {
    await onYes();
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  }
}

function applySubmitResult(result: SubmitDone, live: boolean, close: () => void, fail: (err: unknown) => void, done: () => void) {
  if (!live) return;
  done();
  if (result.ok) close();
  else fail(result.err);
}

function useConfirmSubmit(onYes: () => unknown, live: RefObject<boolean>, busyNow: RefObject<boolean>, close: RefObject<() => void>) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const run = async () => {
    if (busyNow.current) return;
    busyNow.current = true;
    setBusy(true);
    setFailure(null);
    const result = await runAction(onYes);
    busyNow.current = false;
    applySubmitResult(result, live.current, () => close.current(), setFailure, () => setBusy(false));
  };
  return { busy, failure, run };
}

function useBackdropDismiss(dismiss: () => void) {
  const down = useRef(false);
  return {
    onPointerDown(event: SyntheticEvent) {
      keepIn(event);
      down.current = event.target === event.currentTarget;
    },
    onClick(event: SyntheticEvent) {
      keepIn(event);
      if (down.current && event.target === event.currentTarget) dismiss();
      down.current = false;
    },
  };
}

export function ConfirmAction({ title, effect, warnings = [], final = false, yes, working, danger = false, onYes, onClose }: ConfirmActionProps) {
  const t = useT();
  const titleId = useId();
  const effectId = useId();
  const back = useRef<HTMLDialogElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const firstFocus = useRef(danger ? cancel : action);
  const live = useRef(true);
  const busyNow = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;
  const dismiss = useCallback(() => {
    if (!busyNow.current) close.current();
  }, []);
  const { busy, failure, run } = useConfirmSubmit(onYes, live, busyNow, close);
  const backdrop = useBackdropDismiss(dismiss);

  useModalDialog(back, firstFocus, live);
  useEscapeDismiss(dismiss);

  return createPortal(
    <dialog
      ref={back}
      className="dialog-back"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={effectId}
      onKeyDown={event => trapDialogFocus(event, box.current)}
      /* Escape is handled on window keydown; preventing native cancel stops a CloseWatcher from closing a busy dialog
         or closing one immediately on the keyup of the Escape that opened it. */
      onCancel={event => event.preventDefault()}
      onPointerDown={backdrop.onPointerDown}
      onClick={backdrop.onClick}
      onMouseDown={keepIn}
      onSubmit={keepIn}
    >
      <div ref={box} className="dialog arrive">
        <h2 id={titleId}>{title}</h2>
        <p id={effectId}>{effect}</p>
        {warnings.map((line, i) => <p key={i}>{line}</p>)}
        {final && <p data-final="">{t.confirm.final}</p>}
        {failure !== null && <div className="alert" role="alert"><span dir="auto">{errorText(t, failure)}</span></div>}
        <div className="entry-actions" role="group">
          <button ref={action} className={danger ? 'btn danger' : 'btn'} type="button" disabled={busy} aria-busy={busy || undefined} onClick={() => void run()}>
            <BusyLabel busy={busy} idle={yes} working={<><span className="spinner" aria-hidden="true" />{working ?? t.confirm.working}</>} />
          </button>
          <button ref={cancel} className="btn ghost" type="button" disabled={busy} onClick={dismiss}>{t.common.cancel}</button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}

export type Question = Omit<ConfirmActionProps, 'onClose'>;

/* A question a screen asks from any of its buttons: ask() opens it, question is where it renders. A second ask while one
   is open is the same press twice and keeps the first. */
export function useConfirmAction(): { ask: (question: Question) => void; question: ReactNode } {
  const [pending, setPending] = useState<Question | null>(null);
  const ask = useCallback((next: Question) => setPending(current => current ?? next), []);
  const closeIt = useCallback(() => setPending(null), []);
  return { ask, question: pending && <ConfirmAction {...pending} onClose={closeIt} /> };
}
