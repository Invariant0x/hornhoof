import { en, type Messages } from './en';
import type { ShippedLanguage } from './plural';
import { ru } from './ru';

/* Every shipped language's dictionary at once, for the tests and the browser specs that read the words a screen shows.
   The page itself never imports this: it brings one language at a time (index.tsx). A language added to the registry
   needs its line here, which the compiler asks for. */
export const DICTIONARIES: Record<ShippedLanguage, Messages> = { en, ru };
