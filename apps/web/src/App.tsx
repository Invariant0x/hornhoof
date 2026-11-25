import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiFailure, isAway, onSignedOut } from './api';
import { askAgainAfter } from './backoff';
import { useReloadToNewBuild } from './build';
import { useT } from './i18n';
import { forgetOrg } from './org';
import { service } from './service-state';
import { forgetRequestDrafts } from './ui/Requests';
import { AcceptInvite } from './screens/AcceptInvite';
import { Login } from './screens/Login';
import { Setup } from './screens/Setup';
import { Shell } from './screens/Shell';
import type { Me } from './types';
import { ServiceLoader, ServiceStrip, ServiceWindow, useServiceNotice, useServiceView } from './ui/ServiceRoad';
import { VersionMark } from './ui/VersionMark';
import { parseRoute } from './routes';

type Screen =
  | { kind: 'loading' }
  | { kind: 'invite'; token: string }
  | { kind: 'setup'; linkDomain?: string; recovering?: boolean }
  | { kind: 'login' }
  | { kind: 'shell'; me: Me; welcome?: boolean }
  /* The server cannot be reached, or answered with an error: the service road says so, in the page's own place the loader, and
     the page asks again after a growing wait, tries times so far. No page of its own and nothing to press. */
  | { kind: 'away' | 'error'; tries: number; welcome: boolean };

/* What the page shows when its first asks fail: the log in for a session that is not there, or the wait for a server that is
   away or in error, which the service road says and the page asks again from. */
function screenFor(failure: unknown, welcome: boolean, tries: number): Screen {
  if (failure instanceof ApiFailure && failure.status === 401) return { kind: 'login' };
  return { kind: isAway(failure) ? 'away' : 'error', tries: tries + 1, welcome };
}

/* While the page waits for a server that is away or in error, it asks again after a growing wait. */
function useAskAgain(screen: Screen, ask: (welcome: boolean, tries: number) => unknown): void {
  useEffect(() => {
    if (screen.kind !== 'away' && screen.kind !== 'error') return;
    const timer = setTimeout(() => void ask(screen.welcome, screen.tries), askAgainAfter(screen.tries - 1));
    return () => clearTimeout(timer);
  }, [screen, ask]);
}

/* The one place a service state is drawn: the strip over the top of the page, the window over everything, and the page itself
   inert under the window. */
export function App() {
  const view = useServiceView();
  return (
    <div className="app-layout">
      <ServiceStrip />
      {/* Under the window that says the state, nothing takes a key or a click. */}
      <div className="app-screen" inert={view?.place === 'window'}><Screens /></div>
      <VersionMark />
      <ServiceWindow />
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
  /* The person chose to sign out: the session that ends then is no service state. */
  const chose = useRef(false);
  const show = useCallback((next: Screen) => {
    const id = next.kind === 'shell' ? next.me.person.id : null;
    if (id !== person.current) {
      forgetOrg();
      forgetRequestDrafts();
    }
    person.current = id;
    if (next.kind === 'shell') service.signedOut(false);
    setScreen(next);
  }, []);
  useEffect(() => onSignedOut(() => {
    if (person.current === null) return;
    service.signedOut(!chose.current);
    chose.current = false;
    show({ kind: 'login' });
  }), [show]);
  const signOut = useCallback(() => void (chose.current = true), []);
  return [screen, show, signOut] as const;
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
  const [screen, show, signOut] = useScreen();
  useReloadToNewBuild(screen.kind === 'shell');

  const decide = useCallback(async (welcome = false, tries = 0) => {
    const route = parseRoute(window.location.pathname);
    if (route.kind === 'invite') return show({ kind: 'invite', token: route.token });
    try {
      const setup = validSetup(await api.get<{ needed: boolean; linkDomain?: string; recovering?: boolean }>('/api/setup'));
      if (setup.needed) return show({ kind: 'setup', linkDomain: setup.linkDomain, recovering: setup.recovering });
      const me = validMe(await api.get<Me>('/api/me'));
      show({ kind: 'shell', me, welcome });
    } catch (err) {
      show(screenFor(err, welcome, tries));
    }
  }, [show]);

  useEffect(() => {
    void decide();
  }, [decide]);

  useAskAgain(screen, decide);

  /* A load that failed with an answer of the server's own is a notice of the road, until the page asks again and it works. */
  useServiceNotice('app', screen.kind === 'error', t.app.notResponding);

  const home = useCallback(
    (welcome = false) => {
      window.history.replaceState(null, '', '/');
      void decide(welcome);
    },
    [decide],
  );

  switch (screen.kind) {
    case 'loading':
    case 'away':
    case 'error':
      return <ServiceLoader />;
    case 'invite':
      return <AcceptInvite token={screen.token} onDone={home} />;
    case 'setup':
      return <Setup linkDomain={screen.linkDomain} recovering={screen.recovering} onDone={({ welcome }) => home(welcome)} />;
    case 'login':
      return <Login onDone={() => void decide()} />;
    case 'shell':
      /* Each person gets screens of their own: nothing the one before drew stays on them. */
      return <Shell key={screen.me.person.id} me={screen.me} welcome={screen.welcome} onSignOut={() => { signOut(); void decide(); }} />;
  }
}
