import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiFailure } from '../api';
import { errorText, useT } from '../i18n';
import { useStream } from '../live';
import { notOpened, rosterOf } from '../org';
import { RouteUnavailable } from '../screens/RouteUnavailable';
import type { Org } from '../types';
import { everyVisible } from '../guard';

type Status = 'checking' | 'allowed' | 'denied' | 'failure';
type AccessState = { status: Status; org: Org; failure: unknown; verified: string | null };
const RECHECK_MS = 5_000;

function listed(org: Org, agentId: string): boolean {
  if (notOpened(org, agentId)) return false;
  if (org.orchestrator && (agentId === 'orchestrator' || agentId === org.orchestrator.id)) return true;
  return org.departments.some(department => department.employees.some(employee => employee.id === agentId));
}

function statusOf(failure: unknown): Status {
  if (failure instanceof ApiFailure && [403, 404].includes(failure.status)) return 'denied';
  return 'failure';
}

function contentOf(status: Status, t: ReturnType<typeof useT>, failure: unknown, children: ReactNode): ReactNode {
  if (status === 'failure') return <p className="alert" role="alert">{errorText(t, failure)}</p>;
  return status === 'allowed' ? children : null;
}

function keepsVerified(prev: AccessState, path: string, org: Org, agentId: string): boolean {
  return prev.verified === path && !(!listed(org, agentId) && listed(prev.org, agentId));
}

function nextCardAccess(prev: AccessState, card: unknown, path: string, snapshot: Org, agentId: string): AccessState {
  if (card !== null) return { status: 'allowed', org: snapshot, failure: null, verified: path };
  if (keepsVerified(prev, path, snapshot, agentId)) return { status: 'allowed', org: snapshot, failure: null, verified: path };
  return { status: 'failure', org: snapshot, failure: new ApiFailure(502, 'internal', ''), verified: null };
}

function nextErrorAccess(prev: AccessState, err: unknown, path: string, snapshot: Org, agentId: string): AccessState {
  const next = statusOf(err);
  if (next !== 'denied' && keepsVerified(prev, path, snapshot, agentId)) {
    return { status: 'allowed', org: snapshot, failure: null, verified: path };
  }
  return { status: next, org: snapshot, failure: err, verified: null };
}

export function AgentAccess({ agentId, org, onClose, children }: { agentId: string; org: Org; onClose(): void; children: ReactNode }) {
  const t = useT();
  const path = `/api/agents/${agentId}`;
  const snapshot = rosterOf(org);
  const sequence = useRef(0);
  /* An agent the company shows this person but does not open to them has no window: it closes without asking the server. */
  const closed = notOpened(org, agentId);
  const [access, setAccess] = useState<AccessState>(() => ({
    status: listed(org, agentId) ? 'allowed' : 'checking',
    org: snapshot,
    failure: null,
    verified: null,
  }));
  const check = useCallback(async () => {
    if (closed) return;
    const own = ++sequence.current;
    try {
      const card = await api.get(path);
      if (sequence.current !== own) return;
      setAccess(prev => nextCardAccess(prev, card, path, snapshot, agentId));
    } catch (err) {
      if (sequence.current !== own) return;
      setAccess(prev => nextErrorAccess(prev, err, path, snapshot, agentId));
    }
  }, [path, snapshot, agentId, closed]);

  useEffect(() => {
    if (closed) onClose();
  }, [closed, onClose]);

  useEffect(() => {
    void check();
    const stop = everyVisible(() => void check(), RECHECK_MS);
    return () => {
      sequence.current++;
      stop();
    };
  }, [check]);

  useStream(message => {
    if (['org', 'task', 'working', 'reconnected'].includes(message.type)) void check();
  });

  if (closed) return null;
  if (access.status === 'denied') return <RouteUnavailable dialog onHome={onClose} />;
  /* An organization refresh can revoke access. Hide content the new snapshot drops from the roster until it is checked.
     A product's employee or a person's own assistant is on no department roster and still has an authorized card on the
     server: a refresh says nothing new of it, and hiding it would close and build its window again on every one. */
  if (!listed(org, agentId) && access.org !== snapshot && listed(access.org, agentId)) return null;
  return contentOf(access.status, t, access.failure, children);
}
