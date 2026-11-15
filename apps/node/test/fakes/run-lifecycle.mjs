import { runNode } from '../../src/main.ts';

const node = await runNode({
  dir: process.env.FAKE_LIFECYCLE_NODE_DIR,
  log: () => {},
  adapter: {
    install: async () => {},
    loggedIn: async () => true,
    login: async () => {},
    secrets: async () => [],
    run: async () => ({ ok: true, sessionId: null, result: '', output: '', error: null }),
  },
});

process.once('SIGTERM', () => {
  node.stop();
  setTimeout(() => process.exit(0), 100);
});
