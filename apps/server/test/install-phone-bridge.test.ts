import { expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install, SERVER, SUB_A } from './install-script-helpers.js';

it('installs a separate Linux USB helper on the node private network with no Docker socket or public adb', () => {
  const r = install();
  expect(r.code, r.out).toBe(0);
  const name = `hornhoof-claude-${SUB_A.slice(0, 8)}`;
  const helper = r.calls.find(c => c.includes(`--name ${name}-usb `));
  expect(helper).toContain(`--network ${name}-phone`);
  expect(helper).toContain('--device-cgroup-rule c 189:* rmw');
  expect(helper).toContain('--mount type=bind,source=/dev/bus/usb,target=/dev/bus/usb');
  expect(helper).toContain(`-v ${name}:/node-state:ro`);
  expect(helper).not.toContain('docker.sock');
  expect(helper).not.toContain('--privileged');
  expect(helper).not.toContain(' -p ');
  expect(r.calls.find(c => c.includes(`--name ${name} `) && c.startsWith('docker run -d'))).toContain('HORNHOOF_PHONE_BRIDGE=1');
});

it('updates an existing Mac helper from the container updater using its original host path and architecture', () => {
  const root = mkdtempSync(join(tmpdir(), 'hh-phone-host-'));
  const name = `hornhoof-claude-${SUB_A.slice(0, 8)}`;
  const r = install({ args: [], env: { HORNHOOF_FROM_UPDATER: '1', STUB_CONTAINERS: `${name}=${SERVER}`, STUB_NODE_ENV: `HORNHOOF_PHONE_MODE=mac\nHORNHOOF_PHONE_HOST_DIR=${root}\nHORNHOOF_PHONE_HOST_ARCH=arm64\n` } });
  expect(r.code, r.out).toBe(0);
  const installer = r.calls.find(c => c.includes('/app/apps/node/dist/phone-host-install.cjs'));
  expect(installer).toContain(`source=${root},target=/phone-host`);
  expect(installer).toContain(`${root} 43791 arm64`);
  expect(r.calls.some(c => c.startsWith('launchctl'))).toBe(false);
  expect(r.calls.some(c => c.includes(`--name ${name}-usb`))).toBe(false);
});

it('removes a node USB helper with the node and preserves its keys until volume removal is approved', () => {
  const name = `hornhoof-claude-${SUB_A.slice(0, 8)}`;
  const r = install({ args: ['--uninstall'], tty: 'y\nn\n', env: { STUB_CONTAINERS: `${name}=${SERVER}` } });
  expect(r.code, r.out).toBe(0);
  expect(r.calls, JSON.stringify({ out: r.out, calls: r.calls })).toContain(`docker rm -f ${name}-usb`);
  expect(r.calls).toContain(`docker network rm ${name}-phone`);
  expect(r.calls).not.toContain(`docker volume rm ${name}-usb`);
});

it('installs the Mac helper through the normal installer as a user LaunchAgent, without administrator rights', () => {
  const r = install({ env: { STUB_OS: 'Darwin', STUB_ARCH: 'arm64' } });
  expect(r.code, r.out).toBe(0);
  const name = `hornhoof-claude-${SUB_A.slice(0, 8)}`;
  const node = r.calls.find(c => c.includes(`--name ${name} `) && c.startsWith('docker run -d'));
  expect(node).toContain('-p 127.0.0.1::38997');
  expect(node).toContain('HORNHOOF_PHONE_HOST_ARCH=arm64');
  const installer = r.calls.find(c => c.includes('/app/apps/node/dist/phone-host-install.cjs'));
  expect(installer).toContain(`-v ${name}:/node-state:ro`);
  expect(installer).not.toContain('node-key-');
  expect(r.calls.some(c => c.startsWith('launchctl bootstrap gui/1000 '))).toBe(true);
  expect(r.calls.some(c => c.startsWith('sudo launchctl'))).toBe(false);
});
