import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/* A wait ends as soon as its element appears, so a long limit costs a healthy test nothing. The default one second is
   missed on a loaded machine with no fault in the code. It stays well under testTimeout. */
configure({ asyncUtilTimeout: 10000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});
