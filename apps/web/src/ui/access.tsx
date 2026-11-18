import type { Messages } from '../i18n';
import type { AccessMachine } from '../types';

/* A machine by the name its computer told; the server's own with none is "the server's computer". */
export const machineName = (t: Messages, machine: AccessMachine): string => machine.hostname || (machine.data ? t.window.computerServer : machine.name);
