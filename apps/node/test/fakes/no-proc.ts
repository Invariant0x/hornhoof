import { vi } from 'vitest';

const { isProc, missing } = vi.hoisted(() => ({
  isProc: (path: unknown) => /^\/proc(?:\/|$)/.test(String(path)),
  missing: () => Object.assign(new Error('No proc filesystem in this test'), { code: 'ENOENT' }),
}));

vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  const blocked = <T extends (...args: never[]) => unknown>(fn: T): T => new Proxy(fn, {
    apply(target, context, args) {
      return isProc(args[0]) ? Promise.reject(missing()) : Reflect.apply(target, context, args);
    },
  });
  return { ...fs, readFile: blocked(fs.readFile), readdir: blocked(fs.readdir), readlink: blocked(fs.readlink) };
});

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    existsSync: new Proxy(fs.existsSync, { apply: (target, context, args) => !isProc(args[0]) && Reflect.apply(target, context, args) }),
    readFileSync: new Proxy(fs.readFileSync, { apply(target, context, args) {
      if (isProc(args[0])) throw missing();
      return Reflect.apply(target, context, args);
    } }),
  };
});
