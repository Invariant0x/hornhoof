import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiFailure } from '../api';
import { errorText, useT } from '../i18n';
import { useStream } from '../live';
import { RouteUnavailable } from '../screens/RouteUnavailable';
import type { Org } from '../types';

type Status = 'checking' | 'allowed' | 'denied' | 'failure';
const RECHECK_MS = 5_000;

function listed(org: Org, agentId: string): boolean {
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
  const [access, setAccess] = useState<{ status: Status; org: Org; failure: unknown }>(() => ({ status: listed(org, agentId) ? 'allowed' : 'checking', org, failure: null }));
  const check = useCallback(async () => {
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
  }, [path, org]);

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

  if (access.status === 'denied') return <RouteUnavailable dialog onHome={onClose} />;
  /* An organization refresh can revoke access. Hide unlisted content until this snapshot is checked; a product's
     employee may be absent from the department roster and still have an authorized card on the server. */
  if (!listed(org, agentId) && access.org !== org) return null;
  return contentOf(access.status, t, access.failure, children);
}
