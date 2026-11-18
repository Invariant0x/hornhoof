import { type PhoneBinding } from '@hornhoof/protocol';
import { type CompanyPhone } from './store.js';
export const holding = ['starting', 'active', 'revoking'] as const;
export const phoneBinding = (p: CompanyPhone): PhoneBinding => ({ phoneId: p.id, serial: p.serial, hardwareKey: p.hardwareKey });
