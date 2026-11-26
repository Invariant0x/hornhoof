import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type RefObject } from 'react';
import { api } from '../api';
import { deptLabel, errorText, useT } from '../i18n';
import { useStream } from '../live';
import { notOpened, useOrg } from '../org';
import { forgetOwnerKey } from '../owner-key';
import { skinsState, syncCompanySkin } from '../skins/store';
import { useWorld } from '../skins/use-skin';
import type { Me, Org } from '../types';
import { ListIcon, LogoMark, MachineIcon, MapIcon, PeopleIcon, PlugIcon } from '../ui/icons';
import { Idents } from '../ui/Idents';
import { FirstContact } from '../ui/FirstContact';
import { RecoveryBanner } from '../ui/RecoveryBanner';
import { SwitchBanner } from '../ui/SwitchBanner';
import { ShellTop, useMeasuredShellTop, useServiceTop } from '../ui/shellBars';
import { LoadFailure, useLoadFailure } from '../ui/LoadFailure';
import { onTop, useLoad } from '../ui/Loading';
import { UpdateBanner } from '../ui/UpdateBanner';
import { useUpdateRoad } from '../ui/UpdateVersion';
import { UpdateCut } from '../ui/UpdateCut';
import { useVersion, versionText } from '../ui/VersionMark';
import { useDecisions, useImprovements } from '../tasks';
import { GoalPanel } from '../ui/GoalPanel';
import { TaskPanel } from '../ui/TaskPanel';
import { useUpdates, type Updates } from '../updates';
import { About } from './About';
import type { StaffAsk } from './AgentWindow';
import { AgentWindowContext } from './AgentWindowContext';
import { AgentWindows, useAgentWindows } from './AgentWindows';
import { DepartmentView } from './Department';
import { useFeedbackInbox } from './Feedback';
import { FeedbackInbox } from './FeedbackInbox';
import { Improvements } from './Improvements';
import { Machines } from './Machines';
import { MapScreen } from './Map';
import { People } from './People';
import { Settings } from './Settings';
import { Subscriptions } from './Subscriptions';
import { Tasks } from './Tasks';
import { Versions } from './Versions';
import { takeEscape } from '../ui/escape';
import { placeOf, useRoute, type Route, type SettingsGroup, type TrackerPlace } from '../routes';
import { departmentIsMissing, RouteUnavailable, unavailableFailure } from './RouteUnavailable';
import { GuardBoundary, LightNotice } from '../ui/GuardBoundary';
import { guardedResizeObserver } from '../guard';

type Tab = 'map' | 'tasks' | 'people' | 'subscriptions' | 'machines' | 'improvements' | 'inbox';
const TABS: Exclude<Tab, 'improvements' | 'inbox'>[] = ['map', 'tasks', 'people', 'subscriptions', 'machines'];
const TAB_ICONS: Record<(typeof TABS)[number], ComponentType> = { map: MapIcon, tasks: ListIcon, people: PeopleIcon, subscriptions: PlugIcon, machines: MachineIcon };
const ACCOUNT_DIALOGS = ['about', 'versions', 'settings'] as const;
type AccountDialogName = (typeof ACCOUNT_DIALOGS)[number];

function dialogOf(route: Route): AccountDialogName | null {
  return ACCOUNT_DIALOGS.find(kind => kind === route.kind) ?? null;
}

function workspaceOf(route: Route, backgrounds: Route[]) {
  const accountDialog = dialogOf(route);
  const contentRoute = accountDialog ? backgrounds[0]! : route;
  const taskId = contentRoute.kind === 'tasks' ? contentRoute.id ?? null : null;
  const card = contentRoute.kind === 'tasks' && contentRoute.card === 'goal' ? 'goal' : 'task';
  const pageRoute = taskId ? backgrounds[accountDialog ? 1 : 0] ?? { kind: 'tasks' } as const : contentRoute;
  const tab = pageRoute.kind === 'department' ? 'map' : pageRoute.kind;
  const deptId = pageRoute.kind === 'department' ? pageRoute.id : null;
  return { accountDialog, pageRoute, taskId, card, tab, deptId };
}

/* The window of the account menu open over the page. The groups of Settings are one window, so switching between them
   keeps the window and its focus. */
function AccountDialog({ route, me, updates, inbox, onRenamed, onCompanyTheme, onGroup, onClose, onHome }: {
  route: Route | null; me: Me; updates: Updates; inbox: boolean; onRenamed: (name: string) => void;
  onCompanyTheme: (theme: string) => void;
  onGroup: (group?: SettingsGroup) => void; onClose: () => void; onHome: () => void;
}) {
  if (route?.kind === 'about') return <About inbox={inbox} onClose={onClose} />;
  if (route?.kind === 'versions') return <Versions updates={updates} onClose={onClose} onHome={onHome} />;
  if (route?.kind !== 'settings') return null;
  return <Settings me={me} group={route.group} onGroup={onGroup} onRenamed={onRenamed} onCompanyTheme={onCompanyTheme} onClose={onClose} />;
}

/* One row of the account menu: it closes the menu, then does what it says. */
function MenuRow({ label, count, onPick, onClose }: { label: string; count?: { shown: number; said: string }; onPick: () => void; onClose: () => void }) {
  return (
    <button
      className="mi"
      type="button"
      aria-label={count?.shown ? count.said : undefined}
      onClick={() => {
        onClose();
        onPick();
      }}
    >
      <span>{label}</span>
      {count && count.shown > 0 && <span className="nav-count" aria-hidden="true">{count.shown}</span>}
    </button>
  );
}

type MenuProps = {
  me: Me;
  onClose: () => void;
  onSignOut: () => void;
  onImprovements?: () => void;
  onInbox?: () => void;
  onVersions?: () => void;
  onSettings: () => void;
  onAbout: () => void;
  onContact: () => void;
  toDecide: number;
};

/* The pages of the whole company: what employees found to improve with how many wait for a decision, the feedback
   inbox and Versions. Nothing, and no line above it, for a person who sees only some departments. */
function CompanyRows({ onClose, onImprovements, onInbox, onVersions, toDecide }: Omit<MenuProps, 'me' | 'onSignOut' | 'onSettings' | 'onAbout' | 'onContact'>) {
  const t = useT();
  if (!onImprovements && !onInbox && !onVersions) return null;
  return (
    <>
      <hr className="am-sep" />
      {onImprovements && <MenuRow label={t.shell.tabs.improvements} count={{ shown: toDecide, said: t.improvements.nav(toDecide) }} onPick={onImprovements} onClose={onClose} />}
      {onInbox && <MenuRow label={t.inbox.menu} onPick={onInbox} onClose={onClose} />}
      {onVersions && <MenuRow label={t.updates.menu} onPick={onVersions} onClose={onClose} />}
    </>
  );
}

/* The short account menu as Design's reference draws it: the person and the version, then rows in groups with a line
   between them: giving the orchestrator access to this machine, Settings, the pages of the whole company, About and Log
   out. onImprovements, onInbox and onVersions: only for people who see the whole company, onInbox only on Hornhoof's own
   installation. Themes and the language live in Settings, feedback in About. */
function AccountMenu({ me, onClose, onSignOut, onSettings, onAbout, onContact, ...company }: MenuProps) {
  const t = useT();
  const version = useVersion();

  return (
    <div className="account-menu">
      <div className="am-head">
        <b>{me.person.name}</b>
        <span><bdi dir="ltr">{me.person.email}</bdi></span>
        {version && <span className="menu-version"><Idents text={t.shell.version(versionText(version))} idents={[versionText(version)]} /></span>}
      </div>
      <hr className="am-sep" />
      <MenuRow label={t.firstContact.title} onPick={onContact} onClose={onClose} />
      <MenuRow label={t.settings.menu} onPick={onSettings} onClose={onClose} />
      <CompanyRows onClose={onClose} {...company} />
      <hr className="am-sep" />
      <MenuRow label={t.about.menu} onPick={onAbout} onClose={onClose} />
      <MenuRow label={t.shell.logOut} onPick={onSignOut} onClose={onClose} />
    </div>
  );
}

/* The pages of the account menu for people who see the whole company: what employees found to improve, and on Hornhoof's
   own installation the feedback inbox. */
function CompanyPage({ tab, improvements, inbox, onTask, onHome }: {
  tab: Route['kind']; improvements: ReturnType<typeof useImprovements>; inbox: boolean; onTask: (taskId: string) => void; onHome: () => void;
}) {
  if (tab === 'improvements') return <Improvements improvements={improvements.improvements} failure={improvements.failure} inbox={inbox} onChanged={improvements.load} onTask={onTask} onHome={onHome} />;
  if (tab === 'inbox') return <FeedbackInbox onHome={onHome} />;
  return null;
}

/* The section tabs keep their words while all of them fit one line in the room the top bar leaves them: in the middle,
   clear of the logo and the account, or from the start of the row on a phone with no logo. Else each tab shows its icon and
   keeps its name as its label and tooltip. What the words need is measured as they are shown, once for each set of words
   and when the fonts arrive; the room at every resize. An open department's name stands under the menu (#1635). */
function useTabsFit(words: string) {
  const bar = useRef<HTMLElement>(null), nav = useRef<HTMLElement>(null), brand = useRef<HTMLDivElement>(null), side = useRef<HTMLDivElement>(null);
  const [icons, setIcons] = useState(false);
  const [fonts, setFonts] = useState(false);
  const need = useRef<{ words: string; px: number } | null>(null);
  const key = `${words}|${fonts}`;
  useEffect(() => {
    let on = true;
    void document.fonts?.ready.then(() => on && setFonts(true));
    return () => { on = false; };
  }, []);
  useLayoutEffect(() => {
    const top = bar.current, strip = nav.current;
    if (!top || !strip) return;
    const decide = () => {
      if (!top.clientWidth) return;
      if (!icons) need.current = { words: key, px: strip.scrollWidth };
      else if (need.current?.words !== key) {
        setIcons(false);
        return;
      }
      const gap = parseFloat(getComputedStyle(top).columnGap) || 0;
      const logo = brand.current?.offsetWidth ?? 0;
      const start = logo ? logo + gap : 0;
      const end = (side.current?.offsetWidth ?? 0) + gap;
      const room = logo ? top.clientWidth - 2 * Math.max(start, end) : top.clientWidth - start - end;
      setIcons(need.current!.px > room);
    };
    decide();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = guardedResizeObserver(decide, 'tabs');
    observer.observe(top);
    return () => observer.disconnect();
  }, [icons, key]);
  return { bar, nav, brand, side, icons };
}

function ShellTabs({ tab, waiting, navigate, fit }: { tab: Route['kind']; waiting: number; navigate: ReturnType<typeof useRoute>['navigate']; fit: ReturnType<typeof useTabsFit> }) {
  const t = useT();
  return (
    <nav ref={fit.nav} className="tabs glass" data-fit={fit.icons ? 'icons' : undefined} aria-label={t.shell.sections}>
      {TABS.map(id => {
        const count = id === 'tasks' ? waiting : 0;
        const name = count ? t.tasks.navWaiting(count) : t.shell.tabs[id];
        const Icon = TAB_ICONS[id];
        return (
          <button
            key={id}
            type="button"
            className={tab === id ? 'on' : ''}
            aria-current={tab === id ? 'page' : undefined}
            aria-label={count || fit.icons ? name : undefined}
            title={fit.icons ? name : undefined}
            onClick={() => {
              navigate({ kind: id });
            }}
          >
            {fit.icons ? <Icon /> : t.shell.tabs[id]}
            {count > 0 && <span className="nav-count" aria-hidden="true">{count}</span>}
          </button>
        );
      })}
    </nav>
  );
}

function ShellAccount({ me, menu, setMenu, company, inbox, navigate, openAccount, onSignOut, onContact, toDecide, account, accountButton, side }: {
  me: Me; menu: boolean; setMenu: (open: boolean) => void; company: boolean; inbox: boolean;
  navigate: ReturnType<typeof useRoute>['navigate']; openAccount: (next: Route) => void;
  onSignOut: () => void; onContact: () => void; toDecide: number;
  account: RefObject<HTMLDivElement | null>; accountButton: RefObject<HTMLButtonElement | null>; side: RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  return (
    <div className="tb-right" ref={side}>
      <div className="account" ref={account}>
        <button ref={accountButton} className="avatar glass" type="button" aria-label={t.shell.account} aria-expanded={menu} onClick={() => setMenu(!menu)}>
          {me.person.name.trim().charAt(0).toUpperCase()}
        </button>
        {menu && <AccountMenu me={me} onClose={() => setMenu(false)} onSignOut={onSignOut} onContact={onContact} onImprovements={company ? () => navigate({ kind: 'improvements' }) : undefined} onInbox={company && inbox ? () => navigate({ kind: 'inbox' }) : undefined} onVersions={company ? () => openAccount({ kind: 'versions' }) : undefined} onSettings={() => openAccount({ kind: 'settings', group: 'profile' })} onAbout={() => openAccount({ kind: 'about' })} toDecide={toDecide} />}
      </div>
    </div>
  );
}

/* What waits for people as the navigation counts it and the screens show it, and whose decisions the Tasks screen shows
   after a click on a person's card: null shows everyone's. */
function useDecisionsView() {
  const { decisions, failure, load } = useDecisions();
  const requests = decisions?.requests ?? [];
  return {
    all: decisions,
    requests,
    failure,
    load,
    /* What agents ask, the orchestrator's cards and his request for the computer. */
    waiting: decisions?.counts.total ?? 0,
    /* What agents ask on one task, for its panel. */
    requestsOf: (taskId: string) => requests.filter(r => r.task.id === taskId),
  };
}

function AgentWindowError({ shown, org, failure }: { shown: string | null; org: Org | null; failure: unknown }) {
  const t = useT();
  const message = useRef<HTMLParagraphElement>(null);
  const said = useLoadFailure(failure);
  useEffect(() => { message.current?.focus(); }, [shown, org, said]);
  if (!shown || org || said === null) return null;
  return <p ref={message} tabIndex={-1} className="alert" role="alert"><span dir="auto">{errorText(t, said)}</span></p>;
}

type Department = Org['departments'][number];
type MapRouteProps = {
  tab: Route['kind']; me: Me; dept: Department | undefined; missingDepartment: boolean;
  goHome: () => void; openAgent: (id: string) => void; openDecisions: (id: string) => void;
};

function MapWorkspace({
  tab,
  me,
  dept,
  deptId,
  denied,
  missingDepartment,
  panel,
  isWorld,
  goHome,
  openAgent,
  openTask,
  openGoal,
  navigate,
  openDecisions,
  onHire,
}: MapRouteProps & {
  deptId: string | null;
  denied: boolean;
  panel: 'window' | 'task' | null;
  isWorld: boolean;
  openTask: (id: string) => void;
  openGoal: (id: string) => void;
  navigate: ReturnType<typeof useRoute>['navigate'];
  onHire: (dept: Department) => void;
}) {
  /* A world stays mounted behind the other tabs, hidden and paused, so coming back neither reloads nor rebuilds it
     (#1947 item 3); the plain map is drawn afresh each time. */
  const parked = tab !== 'map';
  if ((parked && !isWorld) || denied || missingDepartment || (!isWorld && deptId && !dept)) return null;
  return (
    <MapScreen
      parked={parked}
      me={me}
      onHome={goHome}
      windowOpen={panel === 'window'}
      leftPanelOpen={panel === 'task'}
      onOpenOrchestrator={() => openAgent('orchestrator')}
      onOpenAgent={openAgent}
      inside={!isWorld && !!dept}
      activeDepartmentId={isWorld ? deptId : null}
      onOpenDepartment={id => navigate({ kind: 'department', id })}
      onCloseDepartment={() => navigate({ kind: 'map' })}
      onOpenDecisions={openDecisions}
      onOpenTask={openTask}
      onOpenGoal={openGoal}
      onOpenTracker={id => navigate({ kind: 'tasks', department: id })}
      onOpenTab={nextTab => navigate({ kind: nextTab })}
      onHire={onHire}
    />
  );
}

/* A department opened at its own address before its company came: only its id, until the company says the rest. */
const waitingDepartment = (id: string): Department => ({
  id, name: null, templateKey: null, roleCode: '', about: '', agents: { total: 0, working: 0 }, products: [], teams: [], people: [], employees: [], roles: [],
});

/* The load of a department's company. shown: the department once its load is done, not as soon as the company is there, so
   the ring keeps its least time; before, the department as far as its id says, which stands with the shared indicator in
   its body and says why with Retry when the company does not come. One the update holds keeps the indicator: the panel says
   why, and the load asks again after it. Null for a department the company does not have. */
function useDepartmentLoad(dept: Department | undefined, deptId: string | null, org: Org | null, failure: unknown, loadOrg: () => void) {
  const load = useLoad(deptId ? [{ data: org, failure, load: loadOrg }] : []);
  const waiting = useMemo(() => (deptId ? waitingDepartment(deptId) : null), [deptId]);
  return { load, shown: load.phase === 'done' ? dept ?? null : waiting };
}

/* What the shell tells the map, an open department and the windows beside them while one or both stand: where the room
   under its bars starts, and how much room an open department's name takes under it. Only the map's tab, which holds an
   open department too, floats them over its canvas: a page keeps its own room. */
function shellVars(onMap: boolean, shellTop: number | null, plateRoom: number | null): CSSProperties | undefined {
  if (!onMap || (shellTop === null && plateRoom === null)) return undefined;
  return { ...(shellTop === null ? {} : { '--shell-top': `${shellTop}px` }), ...(plateRoom === null ? {} : { '--plate-room': `${plateRoom}px` }) } as CSSProperties;
}

function DepartmentWorkspace({ tab, me, dept, deptId, denied, missingDepartment, org, orgFailure, loadOrg, shown, panel, goHome, openAgent, openTask, openDecisions, openTracker, openDepartment, onHire, onPlate }: MapRouteProps & {
  deptId: string | null; denied: boolean; org: Org | null; orgFailure: unknown; loadOrg(): void; shown: string | null; panel: 'window' | 'task' | null;
  openTask: (id: string) => void; openTracker: (departmentId: string) => void; openDepartment: (id: string) => void; onHire: (dept: Department) => void;
  onPlate: (room: number | null) => void;
}) {
  const { load, shown: department } = useDepartmentLoad(dept, deptId, org, orgFailure, loadOrg);
  if (tab !== 'map' || denied || missingDepartment || !department) return null;
  return (
    <DepartmentView
      key={department.id}
      me={me}
      department={department}
      load={load}
      deputies={org?.people ?? []}
      selected={shown}
      panel={panel}
      serverNow={org?.serverNow}
      onBack={goHome}
      onOpen={openAgent}
      onOpenTask={openTask}
      onOpenDecisions={openDecisions}
      onOpenTracker={openTracker}
      onOpenDepartment={openDepartment}
      onHire={() => onHire(department)}
      onPlate={onPlate}
    />
  );
}

/* Setup or an accepted invitation opens the orchestrator's first contact at once. */
export function Shell({ me, welcome = false, onSignOut }: { me: Me; welcome?: boolean; onSignOut: () => void }) {
  const t = useT();
  const isWorld = useWorld() !== 'standard';
  const { route, navigate, backgrounds, switchOverlay, closeOverlay } = useRoute();
  const { accountDialog, pageRoute, taskId, card, tab, deptId } = workspaceOf(route, backgrounds);
  const goHome = () => navigate({ kind: 'map' });
  const openAccount = (next: Route) => navigate(next, route);
  const [menu, setMenu] = useState(false);
  const [contact, setContact] = useState(welcome);
  const [selfName, setSelfName] = useState(me.person.name);
  const [companyTheme, setCompanyTheme] = useState<string | undefined>(me.company.theme);
  const lastServerTheme = useRef<string | null>(null);
  const currentMe = { ...me, person: { ...me.person, name: selfName }, company: { ...me.company, ...(companyTheme ? { theme: companyTheme } : {}) } };
  const company = me.person.scopeKind === 'company';
  const inbox = useFeedbackInbox();
  const denied = !company && ['improvements', 'inbox', 'versions'].some(kind => kind === route.kind || kind === pageRoute.kind);
  /* The orchestrator's window opens over the map, for people who see the whole company. */
  const windows = useAgentWindows(null);
  /* A task's panel stands on the left, on its own: it and a window on the screen take each other's place. */
  const [staff, setStaff] = useState<StaffAsk | null>(null);
  const { org, failure: orgFailure, load: loadOrg } = useOrg(windows.ids.length > 0 || taskId !== null || deptId !== null);
  useEffect(() => {
    if (me.company.theme) setCompanyTheme(me.company.theme);
  }, [me.company.theme]);
  useEffect(() => {
    if (org?.company.theme) setCompanyTheme(org.company.theme);
  }, [org?.company.theme]);
  useStream(m => {
    if (m.type === 'company_theme') setCompanyTheme(m.theme);
  });
  useEffect(() => {
    if (!companyTheme) return;
    if (!me.person.isOwner) {
      lastServerTheme.current = companyTheme;
      syncCompanySkin(companyTheme);
      return;
    }
    const changed = lastServerTheme.current !== null && lastServerTheme.current !== companyTheme;
    const isCustom = skinsState().active.startsWith('custom-');
    lastServerTheme.current = companyTheme;
    if (changed || !isCustom) syncCompanySkin(companyTheme);
  }, [companyTheme, me.person.isOwner]);
  const orchestratorId = org?.orchestrator?.id;
  if (orchestratorId && windows.ids.includes(orchestratorId)) windows.nameOrchestrator(orchestratorId);
  const { open: openWindow, hide: hideWindow } = windows;
  useEffect(() => {
    if (taskId) hideWindow();
  }, [taskId, hideWindow]);
  /* An agent the company shows this person but does not open to them gets no window, wherever its name is clicked. */
  const openAgent = useCallback((agentId: string) => {
    if (org && notOpened(org, agentId)) return;
    if (taskId) navigate(pageRoute);
    openWindow(agentId);
  }, [org, openWindow, taskId, navigate, pageRoute]);
  const openTask = useCallback((id: string) => {
    hideWindow();
    navigate({ kind: 'tasks', id }, pageRoute);
  }, [hideWindow, navigate, pageRoute]);
  const openGoal = useCallback((id: string) => {
    hideWindow();
    navigate({ kind: 'tasks', id, card: 'goal' }, pageRoute);
  }, [hideWindow, navigate, pageRoute]);
  /* The tracker's graph grown from a task or a goal. */
  const openGraph = (root: { task?: string; goal?: string }) => navigate(root.task ? { kind: 'tasks', root: root.task, view: 'graph' } : { kind: 'tasks', goal: root.goal, view: 'graph' });
  const toPlace = (place: TrackerPlace) => navigate({ kind: 'tasks', ...place });
  const trackerPlace: TrackerPlace = pageRoute.kind === 'tasks' ? placeOf(pageRoute) : {};
  const shownPanel = windows.shown ? 'window' : taskId ? 'task' : null;
  const dept = deptId ? org?.departments.find(d => d.id === deptId) : undefined;
  const missingDepartment = departmentIsMissing({ deptId, org, orgFailure });
  const updates = useUpdates(company);
  useUpdateRoad(updates);
  const decisions = useDecisionsView();
  /* A person's card, on the map or in a department, opens the decisions screen showing theirs. */
  const openDecisions = (personId: string) => {
    navigate({ kind: 'tasks', show: 'waits', personId });
  };
  const { improvements, failure: improvementsFailure, load: loadImprovements } = useImprovements(company);
  const toDecide = improvements?.filter(i => i.status === 'open').length ?? 0;
  const account = useRef<HTMLDivElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const closeContact = useCallback(() => { setContact(false); accountButton.current?.focus(); }, []);
  const fit = useTabsFit(`${TABS.map(id => t.shell.tabs[id]).join('|')}|${decisions.waiting}`);
  useServiceTop(fit.bar);
  /* Where the room under the bars of the shell starts, which the map and an open department start what they show at. */
  const page = useRef<HTMLElement>(null);
  const shellTop = useMeasuredShellTop(page);
  /* The room an open department's name takes at the top, which the cards open under. */
  const [plateRoom, setPlateRoom] = useState<number | null>(null);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (!takeEscape(e)) return;
      setMenu(false);
      accountButton.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (!account.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [menu]);

  /* The person's key leaves this device with their session, whatever the server answered. */
  async function signOut() {
    try {
      await api.post('/api/auth/logout');
    } finally {
      await forgetOwnerKey();
      onSignOut();
    }
  }

  return (
    <AgentWindowContext value={openAgent}>
    <ShellTop value={shellTop}>
    <div className="shell" style={shellVars(tab === 'map', shellTop, plateRoom)}>
      <header className="topbar" ref={fit.bar}>
        <div className="tb-brand glass" ref={fit.brand}>
          <LogoMark />
          <span className="sr">{me.company.name}</span>
        </div>
        <ShellTabs tab={tab} waiting={decisions.waiting} navigate={navigate} fit={fit} />
        <ShellAccount me={currentMe} menu={menu} setMenu={setMenu} company={company} inbox={inbox} navigate={navigate} openAccount={openAccount} onSignOut={() => void signOut()} onContact={() => setContact(true)} toDecide={toDecide} account={account} accountButton={accountButton} side={fit.side} />
      </header>
      {/* The bars of the shell stand first in the page, each in its own row under the header, and what the page shows
          comes after them. On the map they float over it and an open department, which start under them, and the windows
          and cards open under them too: the shell says where with --shell-top, and how much room an open department's
          name takes under them with --plate-room. */}
      <main ref={page} className={`body${tab === 'map' ? '' : ' page'}${shownPanel ? ` with-${shownPanel}` : ''}${tab === 'tasks' ? ' tracker-page' : ''}`}>
        <SwitchBanner>
          {company && <UpdateBanner updates={updates} onDetails={() => openAccount({ kind: 'versions' })} />}
          <RecoveryBanner me={currentMe} again={accountDialog} onOpen={() => openAccount({ kind: 'settings', group: 'company' })} />
        </SwitchBanner>
        <AgentWindowError shown={windows.shown} org={org} failure={orgFailure} />
        {/* Before the company came, the department says it where it will stand. */}
        {deptId && !unavailableFailure(orgFailure) && <LoadFailure failure={onTop(org, orgFailure)} />}
        {(route.kind === 'unavailable' || route.kind === 'invite' || missingDepartment || denied) && <RouteUnavailable onHome={goHome} />}
        <GuardBoundary block="map" reset={deptId}>
          <MapWorkspace
            tab={tab}
            me={me}
            dept={dept}
            deptId={deptId}
            denied={denied}
            missingDepartment={missingDepartment}
            panel={shownPanel}
            isWorld={isWorld}
            goHome={goHome}
            openAgent={openAgent}
            openTask={openTask}
            openGoal={openGoal}
            navigate={navigate}
            openDecisions={openDecisions}
            onHire={d => {
              setStaff({ id: d.id, name: deptLabel(t, d), at: Date.now() });
              openAgent('orchestrator');
            }}
          />
        </GuardBoundary>
        {!isWorld && (
          <GuardBoundary block="department" reset={deptId}>
            <DepartmentWorkspace tab={tab} me={me} dept={dept} deptId={deptId} denied={denied} missingDepartment={missingDepartment} org={org} orgFailure={orgFailure} loadOrg={loadOrg} shown={windows.shown} panel={shownPanel} goHome={goHome} openAgent={openAgent} openTask={openTask} openDecisions={openDecisions} openTracker={id => navigate({ kind: 'tasks', department: id })} openDepartment={id => navigate({ kind: 'department', id })} onPlate={setPlateRoom} onHire={dept => {
              setStaff({ id: dept.id, name: deptLabel(t, dept), at: Date.now() });
              openAgent('orchestrator');
            }} />
          </GuardBoundary>
        )}
        {tab === 'tasks' && (
          <GuardBoundary block="tasks">
          <Tasks
            me={currentMe}
            place={trackerPlace}
            onPlace={toPlace}
            onHome={goHome}
            decisions={decisions.all}
            decisionsFailure={decisions.failure}
            onDecisionsChanged={decisions.load}
            selected={taskId}
            onOpenTask={openTask}
            onOpenGoal={openGoal}
            onOpenAgent={openAgent}
            onOpenOrchestrator={company ? () => openAgent('orchestrator') : undefined}
          />
          </GuardBoundary>
        )}
        {pageRoute.kind === 'people' && <People me={currentMe} selected={pageRoute.id ?? null} onSelect={id => navigate(id ? { kind: 'people', id } : { kind: 'people' })} onHome={goHome} onRenamed={setSelfName} />}
        {tab === 'subscriptions' && <Subscriptions me={me} onHome={goHome} />}
        {pageRoute.kind === 'machines' && <Machines me={me} selected={pageRoute.id ?? null} onSelect={id => navigate(id ? { kind: 'machines', id } : { kind: 'machines' })} onHome={goHome} />}
        {company && <CompanyPage tab={tab} improvements={{ improvements, failure: improvementsFailure, load: loadImprovements }} inbox={inbox} onTask={openTask} onHome={goHome} />}
      </main>
      <AgentWindows windows={windows} onOpen={openAgent} me={me} org={org} staff={staff} requests={decisions.requests} onRequestsChanged={decisions.load} />
      <LightNotice />
      {contact && <FirstContact onClose={closeContact} />}
      {taskId && card === 'task' && (
        <TaskPanel
          key={`task:${taskId}`}
          taskId={taskId}
          kind={tab === 'tasks' ? 'at-end' : undefined}
          active={!accountDialog && !menu}
          onClose={() => navigate(pageRoute)}
          onOpen={openTask}
          onOpenGoal={openGoal}
          onGraph={openGraph}
          onHome={goHome}
          requests={decisions.requestsOf(taskId)}
          viewerId={me.person.id}
          onRequestsChanged={decisions.load}
          onOpenAgent={openAgent}
        />
      )}
      {taskId && card === 'goal' && (
        <GoalPanel
          key={`goal:${taskId}`}
          goalId={taskId}
          kind={tab === 'tasks' ? 'at-end' : undefined}
          active={!accountDialog && !menu}
          onClose={() => navigate(pageRoute)}
          onOpen={openTask}
          onOpenGoal={openGoal}
          onGraph={openGraph}
          onHome={goHome}
        />
      )}
      <AccountDialog route={!accountDialog || (!company && accountDialog === 'versions') ? null : route} me={currentMe} updates={updates} inbox={inbox} onHome={goHome} onRenamed={setSelfName} onCompanyTheme={setCompanyTheme} onGroup={group => switchOverlay(group ? { kind: 'settings', group } : { kind: 'settings' })} onClose={() => { closeOverlay(); accountButton.current?.focus(); }} />
      {company && updates.cut && <UpdateCut cut={updates.cut} updates={updates} />}
    </div>
    </ShellTop>
    </AgentWindowContext>
  );
}
