/* Built as a plain script of its own and run from the top of index.html, before the page draws, so the chosen skin never
   shows another one first. See skins-boot.config.ts. */
import { initSkins } from './store';

initSkins();
