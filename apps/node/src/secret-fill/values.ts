import { inspect } from 'node:util';
import { HIDDEN } from '../redact.js';

/* One value of a vault sign-in. It prints, serializes and inspects as hidden, so a log line or an error that takes it by
   mistake carries nothing; only reveal gives the value, to the code that types it. */
export class SecretValue {
  readonly #plain: string;

  constructor(plain: string) {
    this.#plain = plain;
  }

  reveal<T>(use: (plain: string) => T): T {
    return use(this.#plain);
  }

  toString(): string {
    return HIDDEN;
  }

  toJSON(): string {
    return HIDDEN;
  }

  [inspect.custom](): string {
    return HIDDEN;
  }
}
