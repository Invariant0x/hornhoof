import { describe, expect, it } from 'vitest';
import config from '../vite.config';

describe('the dev server', () => {
  it("passes /api on to the server, the agent terminal's WebSocket too", () => {
    expect(config({ command: 'serve', mode: 'development' }).server?.proxy?.['/api']).toEqual({ target: 'http://localhost:8080', ws: true });
  });
});
