import { useCallback, type ReactNode } from 'react';
import { api } from '../api';
import type { Messages } from '../i18n';
import { canMakeKey } from '../owner-key';
import { DURATION_S, type AccessDuration, type AccessMachine, type AccessScope, type ComputerAccessView, type DecidedBy } from '../types';
import { useOwnerKey } from './PasswordPrompt';

export type AccessAnswer = 'open' | 'close' | 'decline';
/* What its owner chose before opening a machine: for whom and for how long. Every agent of the company is opened only
   after the owner said yes once more, which confirm carries. Nothing chosen: the orchestrator, for the first duration. */
export type AccessChoice = { scope: AccessScope; duration: AccessDuration; confirm?: true };
const FIRST: AccessChoice = { scope: 'orchestrator', duration: '1h' };

/* A machine by the name its computer told; the server's own with none is "the server's computer". */
export const machineName = (t: Messages, machine: AccessMachine): string => machine.hostname || (machine.data ? t.window.computerServer : machine.name);

export const isOpen = (view: ComputerAccessView): boolean => view.until !== null && Date.parse(view.until) > Date.now();

/* What open access gives the orchestrator on this machine, in the words its owner reads before opening it. */
export function givesLines(t: Messages, view: ComputerAccessView): string[] {
  const name = machineName(t, view.machine);
  const gives = view.machine.data ? t.window.computerGivesData(name) : t.window.computerGives(name);
  const mac = view.machine.os === 'darwin' ? [t.window.computerMac] : view.machine.os === null ? [t.window.computerMaybeMac(name)] : [];
  return [gives, ...mac];
}

/* Why this person cannot open the machine now though it is theirs to open, or null: its core does not answer, it does
   not hold their key, or this page can sign nothing with it. */
export function cannotOpen(t: Messages, view: ComputerAccessView): string | null {
  const name = machineName(t, view.machine);
  if (!view.canOpen) return null;
  if (view.key === 'not_held') return t.window.computerKeyNotHeld(name);
  if (!view.reachable) return t.window.computerUnreachable(name);
  if (view.key === 'held' && !canMakeKey()) return t.window.computerNoSigning;
  return null;
}

/* Who takes the decision on a machine this person may not open. */
export const decidesAccess = (view: ComputerAccessView): DecidedBy => ({ kind: view.key === 'not_needed' ? 'ceo_and_delegate' : 'machine_owner', department: null });

/* Opening, closing and saying no, each to its machine. A machine that holds its owner's key opens with what the owner
   signs here: the password is asked once on a device, and whoever leaves that question opens nothing. The caller shows
   prompt where the buttons were. What the owner signs spans exactly the chosen duration, as the server requires. */
export function useAccess(onChange: (next: ComputerAccessView) => void, onFailure: (err: unknown) => void): { answer(view: ComputerAccessView, action: AccessAnswer, choice?: AccessChoice): Promise<void>; prompt: ReactNode } {
  const { sign, prompt } = useOwnerKey();
  const answer = useCallback(
    async (view: ComputerAccessView, action: AccessAnswer, choice: AccessChoice = FIRST): Promise<void> => {
      try {
        let body: (Partial<AccessChoice> & { grant?: { payload: string; signature: string } }) | undefined;
        if (action === 'open') {
          body = { ...choice };
          if (view.key === 'held') {
            const grant = await sign(view.machine.networkId, DURATION_S[choice.duration]);
            if (!grant) return;
            body = { ...body, grant };
          }
        }
        onChange(await api.post<ComputerAccessView>(`/api/machines/${view.machine.id}/access/${action}`, body));
      } catch (err) {
        onFailure(err);
      }
    },
    [sign, onChange, onFailure],
  );
  return { answer, prompt };
}
