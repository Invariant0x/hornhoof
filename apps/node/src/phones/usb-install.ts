import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const run = promisify(execFile);
export const MAC_PHONE_ASSETS = {
  arm64: { url: 'https://nodejs.org/dist/v22.23.4/node-v22.23.4-darwin-arm64.tar.gz', sha: 'c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428', folder: 'node-v22.23.4-darwin-arm64' },
  x86_64: { url: 'https://nodejs.org/dist/v22.23.4/node-v22.23.4-darwin-x64.tar.gz', sha: 'efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819', folder: 'node-v22.23.4-darwin-x64' },
  adb: { url: 'https://dl.google.com/android/repository/platform-tools_r37.0.0-darwin.zip', sha: '094a1395683c509fd4d48667da0d8b5ef4d42b2abfcd29f2e8149e2f989357c7' },
} as const;

export async function checkedPhoneAsset(url: string, sha: string, request: typeof fetch = fetch): Promise<Buffer> {
  const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error('phone_bridge_download_failed');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 100 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== sha) throw new Error('phone_bridge_download_invalid');
  return bytes;
}

const xml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export function phoneLaunchAgent(root: string, label: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array><string>${xml(join(root, 'node/bin/node'))}</string><string>${xml(join(root, 'phone-host.cjs'))}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>EnvironmentVariables</key><dict><key>HORNHOOF_PHONE_CONFIG</key><string>${xml(join(root, 'host.json'))}</string><key>ANDROID_USER_HOME</key><string>${xml(join(root, 'android'))}</string></dict></dict></plist>\n`;
}

async function privateJson(path: string, value: unknown): Promise<void> {
  await writeFile(`${path}.new`, JSON.stringify(value), { mode: 0o600 });
  await chmod(`${path}.new`, 0o600); await rename(`${path}.new`, path);
}

/* Runs in the pinned node image with just the node state read-only and this helper's host directory mounted. */
export async function installMacPhone(root: string, port: number, arch: 'arm64' | 'x86_64', server: string, image: string): Promise<void> {
  if (!root.startsWith('/') || /[\x00-\x1f]/.test(root) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('phone_bridge_config_invalid');
  const target = '/phone-host';
  const asset = MAC_PHONE_ASSETS[arch];
  await mkdir(target, { recursive: true, mode: 0o700 }); await chmod(target, 0o700);
  await mkdir(join(target, 'android'), { recursive: true, mode: 0o700 });
  const versions = { node: asset.sha, adb: MAC_PHONE_ASSETS.adb.sha };
  let installed: unknown = null;
  try { installed = JSON.parse(await readFile(join(target, 'assets.json'), 'utf8')); } catch { /* First installation. */ }
  if (JSON.stringify(installed) !== JSON.stringify(versions)) {
    const stage = join(target, `stage-${randomUUID()}`);
    await mkdir(stage, { mode: 0o700 });
    try {
      await writeFile(join(stage, 'node.tar.gz'), await checkedPhoneAsset(asset.url, asset.sha));
      await writeFile(join(stage, 'adb.zip'), await checkedPhoneAsset(MAC_PHONE_ASSETS.adb.url, MAC_PHONE_ASSETS.adb.sha));
      await run('tar', ['-xzf', join(stage, 'node.tar.gz'), '-C', stage]);
      await run('unzip', ['-q', join(stage, 'adb.zip'), '-d', stage]);
      await rm(join(target, 'node.old'), { recursive: true, force: true });
      await rename(join(target, 'node'), join(target, 'node.old')).catch(() => {});
      await rename(join(stage, asset.folder), join(target, 'node'));
      await rm(join(target, 'platform-tools.old'), { recursive: true, force: true });
      await rename(join(target, 'platform-tools'), join(target, 'platform-tools.old')).catch(() => {});
      await rename(join(stage, 'platform-tools'), join(target, 'platform-tools'));
      await privateJson(join(target, 'assets.json'), versions);
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  // Files are replaced atomically. The running helper watches installed.id and launchd restarts the new bundle.
  await copyFile('/app/apps/node/dist/phone-host.cjs', join(target, 'phone-host.cjs.new'));
  await rename(join(target, 'phone-host.cjs.new'), join(target, 'phone-host.cjs'));
  await copyFile('/app/apps/node/dist/phone-host.cjs.LEGAL.txt', join(target, 'phone-host.cjs.LEGAL.txt')).catch(() => {});
  await copyFile('/node-state/node.json', join(target, 'node.json.new')); await chmod(join(target, 'node.json.new'), 0o600);
  await rename(join(target, 'node.json.new'), join(target, 'node.json'));
  await privateJson(join(target, 'host.json'), { stateFile: join(root, 'node.json'), socket: `ws://127.0.0.1:${port}/phone-bridge`, server, adb: join(root, 'platform-tools/adb'), marker: join(root, 'installed.id') });
  await writeFile(join(target, 'agent.plist'), phoneLaunchAgent(root, `org.hornhoof.phone.${root.split('/').at(-1)}`), { mode: 0o600 });
  await writeFile(join(target, 'installed.id.new'), `${image}\n${randomUUID()}\n`, { mode: 0o600 });
  await rename(join(target, 'installed.id.new'), join(target, 'installed.id'));
}
