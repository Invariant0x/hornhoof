import { installMacPhone } from './usb-install.js';
import { writeFile } from 'node:fs/promises';

const [root, port, arch, server, image] = process.argv.slice(2);
if (root === '--remove') void writeFile('/phone-host/installed.id', 'removed', { mode: 0o600 }).catch(() => { process.exitCode = 1; });
else if (!root || !port || (arch !== 'arm64' && arch !== 'x86_64') || !server || !image) process.exitCode = 1;
else void installMacPhone(root, Number(port), arch, server, image).catch(() => {
  process.stderr.write('The Hornhoof USB phone helper could not be installed.\n'); process.exitCode = 1;
});
