/* Built as a plain script of its own and run from the top of index.html, before the page draws, so a chosen theme or a
   custom template never shows the default one first. See themeBoot in vite.config.ts. */
import { initTheme } from './theme';

initTheme();
