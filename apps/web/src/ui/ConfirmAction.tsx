import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useT } from '../i18n';
import { takeEscape } from './escape';

export type ConfirmActionProps = {
  action: string;
  warnings?: readonly string[];
  onYes: () => void;
  onNo: () => void;
};

/* Every new critical action a person can take in the interface must use this question before it sends its request.
   Name the action and its target. Keep server permissions and approval records in force.

   Use it to delete a person or assistant, rename a person or assistant (including one's own name), disable a
   person or change their access or deputy authority, remove an employee, reset employee instructions, disconnect an
   employee's plan, stop an employee's current work, remove a department or product, rename or remove a sub-unit.
   Disconnect or remove a machine, remove a former server, move the server or stop a move, change backup placement,
   open or close computer access, update machine programs, remove a plan or API key, replace a saved plan key, rename
   or retarget an API plan, switch the orchestrator's plan, remove a fallback, stop lending a phone.
   Restore a backup on the current or a replacement server, leave a database out, choose the copy to go on from,
   update the server now, cancel or pause a task, remove a pipeline stage, backlog item or note, hide a secret, apply
   a repository merge decision, change a department owner, approval rules or autonomous release.
   Remove or replace a repository connection or host key, remove or change a public URL, remove a vault entry or
   replace its secret, revoke or replace an assistant key, disconnect Google Sheets or a Telegram bot. */
export function ConfirmAction({ action, warnings, onYes, onNo }: ConfirmActionProps) {
  const t = useT().confirmAction;
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const yes = useRef<HTMLButtonElement>(null);
  const no = useRef<HTMLButtonElement>(null);
  const decided = useRef(false);

  useLayoutEffect(() => {
    const box = dialog.current!;
    const opener = document.activeElement;
    box.showModal();
    no.current?.focus();
    return () => {
      box.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const decide = useCallback((callback: () => void) => {
    if (decided.current) return;
    decided.current = true;
    callback();
  }, []);

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (dialog.current?.contains(document.activeElement) && takeEscape(event)) decide(onNo);
    }
    // Close this question before a settings window, task panel or employee window can take the same Escape.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [decide, onNo]);

  function loopTab(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab') return;
    const [edge, next] = event.shiftKey ? [yes, no] : [no, yes];
    if (document.activeElement !== edge.current) return;
    event.preventDefault();
    next.current?.focus();
  }

  function outside(event: PointerEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget) return;
    const { left, top, right, bottom } = event.currentTarget.getBoundingClientRect();
    if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) {
      event.preventDefault();
      decide(onNo);
    }
  }

  const hasWarnings = warnings !== undefined && warnings.length > 0;
  return (
    <dialog ref={dialog} className="dialog confirm-action" role="alertdialog" aria-modal="true"
      aria-labelledby={`${id}-question`} aria-describedby={hasWarnings ? `${id}-action ${id}-warnings` : `${id}-action`}
      onKeyDown={loopTab} onPointerDown={outside} onCancel={event => { event.preventDefault(); decide(onNo); }}>
      <h2 id={`${id}-question`}>{t.question}</h2>
      <p id={`${id}-action`}><bdi dir="auto">{action}</bdi></p>
      {hasWarnings && <ul id={`${id}-warnings`}>{warnings.map((warning, i) => <li key={i}><bdi dir="auto">{warning}</bdi></li>)}</ul>}
      <div className="form-foot">
        <button ref={yes} className="btn" type="button" onClick={() => decide(onYes)}>{t.yes}</button>
        <button ref={no} className="btn ghost" type="button" onClick={() => decide(onNo)}>{t.no}</button>
      </div>
    </dialog>
  );
}

type PendingAction = Omit<ConfirmActionProps, 'onNo'>;

export function useConfirmAction() {
  const [pending, setPending] = useState<PendingAction | null>(null);
  const ask = useCallback((action: PendingAction) => setPending(current => current ?? action), []);
  const close = () => setPending(null);
  const question = pending && <ConfirmAction {...pending} onNo={close} onYes={() => { close(); pending.onYes(); }} />;
  return { ask, question };
}
