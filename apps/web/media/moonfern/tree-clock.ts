import { clockIso } from './clock';

export { clockIso };

export const secondsBetweenIso = (from: string, to: string): number =>
  Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
