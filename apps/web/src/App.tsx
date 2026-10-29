import { useCallback, useEffect, useState } from 'react';
import { api, ApiFailure } from './api';
import { AcceptInvite } from './screens/AcceptInvite';
import { Login } from './screens/Login';
import { Setup } from './screens/Setup';
import { Shell } from './screens/Shell';
import type { Me } from './types';
import { Card } from './ui/Card';

type Screen =
  | { kind: 'loading' }
  | { kind: 'invite'; token: string }
  | { kind: 'setup' }
  | { kind: 'login' }
  | { kind: 'shell'; me: Me }
  | { kind: 'error'; message: string };

const INVITE_PATH = /^\/invite\/([^/]+)\/?$/;

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });

  const decide = useCallback(async () => {
    const invite = window.location.pathname.match(INVITE_PATH);
    if (invite) return setScreen({ kind: 'invite', token: decodeURIComponent(invite[1]!) });
    try {
      const { needed } = await api.get<{ needed: boolean }>('/api/setup');
      if (needed) return setScreen({ kind: 'setup' });
      setScreen({ kind: 'shell', me: await api.get<Me>('/api/me') });
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 401) return setScreen({ kind: 'login' });
      setScreen({ kind: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
    }
  }, []);

  useEffect(() => {
    void decide();
  }, [decide]);

  const home = useCallback(() => {
    window.history.replaceState(null, '', '/');
    void decide();
  }, [decide]);

  switch (screen.kind) {
    case 'loading':
      return null;
    case 'invite':
      return <AcceptInvite token={screen.token} onDone={home} />;
    case 'setup':
      return <Setup onDone={home} />;
    case 'login':
      return <Login onDone={home} />;
    case 'shell':
      return <Shell me={screen.me} onSignOut={home} />;
    case 'error':
      return (
        <Card>
          <h1>Hornhoof is not responding</h1>
          <p className="muted">{screen.message}</p>
          <div className="actions">
            <button className="btn" type="button" onClick={home}>Try again</button>
          </div>
        </Card>
      );
  }
}
