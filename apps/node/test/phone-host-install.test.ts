import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { checkedPhoneAsset, phoneLaunchAgent, MAC_PHONE_ASSETS } from '../src/phones/usb-install.js';

it('pins native assets for both Mac architectures and rejects changed bytes', async () => {
  const bytes = Buffer.from('recorded archive bytes');
  const request: typeof fetch = async () => new Response(bytes);
  const sha = createHash('sha256').update(bytes).digest('hex');
  await expect(checkedPhoneAsset('https://example.test/recorded', sha, request)).resolves.toEqual(bytes);
  await expect(checkedPhoneAsset('https://example.test/recorded', 'a'.repeat(64), request)).rejects.toThrow('phone_bridge_download_invalid');
  expect(MAC_PHONE_ASSETS.arm64.url).toContain('darwin-arm64');
  expect(MAC_PHONE_ASSETS.x86_64.url).toContain('darwin-x64');
});

it('launches from a private user directory, escapes paths and puts no key on the command line', () => {
  const plist = phoneLaunchAgent('/Users/Person & Company/.hornhoof/phones/hornhoof-node', 'org.hornhoof.phone.demo');
  expect(plist).toContain('/Users/Person &amp; Company/');
  expect(plist).toContain('HORNHOOF_PHONE_CONFIG');
  expect(plist).not.toContain('Bearer');
  expect(plist).not.toContain('<key>UserName</key>');
});
