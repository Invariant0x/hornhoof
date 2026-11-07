import { vi } from 'vitest';
import { ids, network } from './measure-machines.js';

/* Only the OS identity operations a machine without root cannot do are doubled: git, installers, builds, files and commands are
   real. A closed network is a proxy nobody listens on, which the tools of every language obey. */
const NOWHERE = 'http://127.0.0.1:9';
const CLOSED = { HTTP_PROXY: NOWHERE, HTTPS_PROXY: NOWHERE, ALL_PROXY: NOWHERE, http_proxy: NOWHERE, https_proxy: NOWHERE, all_proxy: NOWHERE, JAVA_TOOL_OPTIONS: '-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=9 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=9' };
vi.mock('node:child_process', async original => {
  const module = await original<typeof import('node:child_process')>();
  return { ...module, spawn: (bin: string, args: string[], options: import('node:child_process').SpawnOptions) => module.spawn(bin, args, { ...options, uid: undefined, gid: undefined, ...(network.closed ? { env: { ...options.env, ...CLOSED } } : {}) }) };
});
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), chownSync: () => {}, fchownSync: () => {} }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), chown: async () => {} }));
vi.mock('../src/isolation.js', async original => {
  const module = await original<typeof import('../src/isolation.js')>();
  return { ...module, userFor: () => ({ uid: ids.builderUid, gid: ids.builderUid }), ensurePasswd: () => {}, prepareFolder: (path: string) => module.prepareFolder(path, null) };
});
