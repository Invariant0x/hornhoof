import { useCallback, useEffect, useState } from 'react';
import { api, ApiFailure } from './api';
import { errorText, useT } from './i18n';
import { AcceptInvite } from './screens/AcceptInvite';
import { Login } from './screens/Login';
import { Setup } from './screens/Setup';
import { Shell } from './screens/Shell';
import type { Me } from './types';
import { Card } from './ui/Card';
import { VersionMark } from './ui/VersionMark';

type Screen =
  | { kind: 'loading' }
  | { kind: 'invite'; token: string }
  | { kind: 'setup' }
  | { kind: 'login' }
  | { kind: 'shell'; me: Me; welcome?: boolean }
  | { kind: 'error'; failure: unknown };

const INVITE_PATH = /^\/invite\/([^/]+)\/?$/;

export function App() {
  return (
    <>
      <Screens />
      <VersionMark />
    </>
  );
}

function Screens() {
  const t = useT();
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });

  const decide = useCallback(async (welcome = false) => {
    const invite = window.location.pathname.match(INVITE_PATH);
    if (invite) return setScreen({ kind: 'invite', token: decodeURIComponent(invite[1]!) });
    try {
      const { needed } = await api.get<{ needed: boolean }>('/api/setup');
      if (needed) return setScreen({ kind: 'setup' });
      setScreen({ kind: 'shell', me: await api.get<Me>('/api/me'), welcome });
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 401) return setScreen({ kind: 'login' });
      setScreen({ kind: 'error', failure: err });
    }
  }, []);

  useEffect(() => {
    void decide();
  }, [decide]);

  const home = useCallback(
    (welcome = false) => {
      window.history.replaceState(null, '', '/');
      void decide(welcome);
    },
    [decide],
  );

  switch (screen.kind) {
    case 'loading':
      return null;
    case 'invite':
      return <AcceptInvite token={screen.token} onDone={() => home()} />;
    case 'setup':
      return <Setup onDone={({ welcome }) => home(welcome)} />;
    case 'login':
      return <Login onDone={() => home()} />;
    case 'shell':
      return <Shell me={screen.me} welcome={screen.welcome} onSignOut={() => home()} />;
    case 'error':
      return (
        <Card>
          <h1>{t.app.notResponding}</h1>
          <p className="muted">{errorText(t, screen.failure)}</p>
          <div className="actions">
            <button className="btn" type="button" onClick={() => home()}>{t.app.tryAgain}</button>
          </div>
        </Card>
      );
  }
}
