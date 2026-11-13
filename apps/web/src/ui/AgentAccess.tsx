import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiFailure } from '../api';
import { errorText, useT } from '../i18n';
import { useStream } from '../live';
import { notOpened } from '../org';
import { RouteUnavailable } from '../screens/RouteUnavailable';
import type { Org } from '../types';

type Status = 'checking' | 'allowed' | 'denied' | 'failure';
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

export function AgentAccess({ agentId, org, onClose, children }: { agentId: string; org: Org; onClose(): void; children: ReactNode }) {
  const t = useT();
  const path = `/api/agents/${agentId}`;
  const sequence = useRef(0);
  /* An agent the company shows this person but does not open to them has no window: it closes without asking the server. */
  const closed = notOpened(org, agentId);
  const [access, setAccess] = useState<{ status: Status; org: Org; failure: unknown }>(() => ({ status: listed(org, agentId) ? 'allowed' : 'checking', org, failure: null }));
  const check = useCallback(async () => {
    if (closed) return;
    const own = ++sequence.current;
    try {
      await api.get(path);
      if (sequence.current === own) {
        setAccess({ status: 'allowed', org, failure: null });
      }
    } catch (err) {
      if (sequence.current !== own) return;
      setAccess({ status: statusOf(err), org, failure: err });
    }
  }, [path, org, closed]);

  useEffect(() => {
    if (closed) onClose();
  }, [closed, onClose]);

  useEffect(() => {
    void check();
    const timer = setInterval(() => void check(), RECHECK_MS);
    return () => {
      sequence.current++;
      clearInterval(timer);
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
  if (!listed(org, agentId) && access.org !== org && listed(access.org, agentId)) return null;
  return contentOf(access.status, t, access.failure, children);
}
