import { useState } from 'react';
import { api } from '../api';
import { currentTheme, setTheme, type Theme } from '../theme';
import type { Me } from '../types';
import { LogoMark } from '../ui/icons';
import { MapScreen } from './Map';
import { People } from './People';

type Tab = 'map' | 'people';
const TABS: { id: Tab; label: string }[] = [
  { id: 'map', label: 'Map' },
  { id: 'people', label: 'People' },
];

export function Shell({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const [tab, setTab] = useState<Tab>('map');
  const [theme, setThemeState] = useState<Theme>(currentTheme);
  const [menu, setMenu] = useState(false);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setThemeState(next);
  }

  async function signOut() {
    try {
      await api.post('/api/auth/logout');
    } finally {
      onSignOut();
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="tb-brand">
          <LogoMark />
          <span>{me.company.name}</span>
        </div>
        <nav className="tabs" aria-label="Sections">
          {TABS.map(t => (
            <button key={t.id} type="button" className={tab === t.id ? 'on' : ''} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="tb-right">
          <button className="iconbtn" type="button" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              {theme === 'dark' ? (
                <>
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                </>
              ) : (
                <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
              )}
            </svg>
          </button>
          <div className="account">
            <button className="avatar" type="button" aria-label="Account" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              {me.person.name.trim().charAt(0).toUpperCase()}
            </button>
            {menu && (
              <div className="account-menu" role="menu">
                <p>
                  <b>{me.person.name}</b>
                  <span>{me.person.email}</span>
                </p>
                <button className="btn small ghost" type="button" role="menuitem" onClick={signOut}>Log out</button>
              </div>
            )}
          </div>
        </div>
      </header>
      <main className="body">{tab === 'map' ? <MapScreen /> : <People me={me} />}</main>
    </div>
  );
}
