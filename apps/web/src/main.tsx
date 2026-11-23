import '@fontsource/onest/400.css';
import '@fontsource/onest/500.css';
import '@fontsource/onest/600.css';
import '@fontsource/tektur/500.css';
import '@fontsource/tektur/600.css';
import './fonts/handjet/handjet.css';
import './fonts/alegreya/alegreya.css';
import './fonts/golos-text/golos-text.css';
import './theme.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { watchFrames } from './guard';
import { LanguageProvider } from './i18n';
import { initSkins } from './skins/store';

initSkins();
/* Frames that keep coming late turn the page light before the browser gives up on the tab. */
watchFrames({ every: 2000, budget: 250, strikes: 3, now: () => performance.now(), frame: cb => requestAnimationFrame(cb) });
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </StrictMode>,
);
