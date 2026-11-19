import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiFailure, onSignedOut } from './api';
import { useNewBuild } from './build';
import { errorText, useT } from './i18n';
import { forgetOrg } from './org';
import { forgetRequestDrafts } from './ui/Requests';
import { AcceptInvite } from './screens/AcceptInvite';
import { Login } from './screens/Login';
import { Setup } from './screens/Setup';
import { Shell } from './screens/Shell';
import type { Me } from './types';
import { Card } from './ui/Card';
import { VersionMark } from './ui/VersionMark';
import { parseRoute } from './routes';
import { page } from './updates';

type Screen =
  | { kind: 'loading' }
  | { kind: 'invite'; token: string }
  | { kind: 'setup'; linkDomain?: string; recovering?: boolean }
  | { kind: 'login' }
  | { kind: 'shell'; me: Me; welcome?: boolean }
  | { kind: 'error'; failure: unknown };

export function App() {
  return (
    <div className="app-layout">
      <div className="app-screen"><Screens /></div>
      <VersionMark />
    </div>
  );
}

/* Whoever comes on this tab next sees nothing of the company the one before saw, however they came: the company leaves
   every screen, with the answers still on their way for it, and so do the answers the one before typed and did not
   send, before the next screen draws. A session the server ended while someone was signed in here takes the tab to log
   in at once, the same way. */
function useScreen() {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
  const person = useRef<string | null>(null);
  const show = useCallback((next: Screen) => {
    const id = next.kind === 'shell' ? next.me.person.id : null;
    if (id !== person.current) {
      forgetOrg();
      forgetRequestDrafts();
    }
    person.current = id;
    setScreen(next);
  }, []);
  useEffect(() => onSignedOut(() => person.current !== null && show({ kind: 'login' })), [show]);
  return [screen, show] as const;
}

function validSetup(setup: { needed: boolean; linkDomain?: string; recovering?: boolean } | null) {
  if (!setup || typeof setup.needed !== 'boolean') throw new ApiFailure(502, 'internal', '');
  return setup;
}

function validMe(me: Me | null): Me {
  if (!me?.person?.id || !me?.company?.id) throw new ApiFailure(502, 'internal', '');
  return me;
}

function Screens() {
  const t = useT();
  const [screen, show] = useScreen();
  const newBuild = useNewBuild();

  /* A tab nobody is signed in on takes the server's new build at once; one a person works on keeps what they typed
     until their session ends. */
  useEffect(() => {
    if (newBuild && screen.kind !== 'shell') page.reload();
  }, [newBuild, screen.kind]);

  const decide = useCallback(async (welcome = false) => {
    const route = parseRoute(window.location.pathname);
    if (route.kind === 'invite') return show({ kind: 'invite', token: route.token });
    try {
      const setup = validSetup(await api.get<{ needed: boolean; linkDomain?: string; recovering?: boolean }>('/api/setup'));
      if (setup.needed) return show({ kind: 'setup', linkDomain: setup.linkDomain, recovering: setup.recovering });
      const me = validMe(await api.get<Me>('/api/me'));
      show({ kind: 'shell', me, welcome });
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 401) return show({ kind: 'login' });
      show({ kind: 'error', failure: err });
    }
  }, [show]);

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
      return <AcceptInvite token={screen.token} onDone={home} />;
    case 'setup':
      return <Setup linkDomain={screen.linkDomain} recovering={screen.recovering} onDone={({ welcome }) => home(welcome)} />;
    case 'login':
      return <Login onDone={() => void decide()} />;
    case 'shell':
      /* Each person gets screens of their own: nothing the one before drew stays on them. */
      return <Shell key={screen.me.person.id} me={screen.me} welcome={screen.welcome} onSignOut={() => void decide()} />;
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
