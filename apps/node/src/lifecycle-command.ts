import { NodeStopReason } from '@hornhoof/protocol';
import { prepareNodeStop } from './lifecycle.js';
import { dataDir } from './state.js';

/* Runs before the ordinary command dispatcher; old commands keep their existing behavior. */
export function lifecycleCommand(args: string[]): number | null {
  if (args[0] !== 'prepare-stop') return null;
  if (args.length !== 2) throw new Error('Usage: hornhoof-node prepare-stop <reason>');
  prepareNodeStop(dataDir(), NodeStopReason.parse(args[1]));
  return 0;
}
