import { build } from 'esbuild';

await build({ entryPoints: { 'phone-host': 'src/phones/usb-entry.ts', 'phone-host-install': 'src/phones/usb-install-entry.ts' }, outdir: 'dist', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', legalComments: 'linked' });
