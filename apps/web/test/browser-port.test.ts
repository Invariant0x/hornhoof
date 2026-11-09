import { describe, expect, it } from 'vitest';
import { browserPort } from '../e2e/browser-port';

/* The ports Chromium refuses with net::ERR_UNSAFE_PORT, as its port_util lists them. */
const CHROMIUM_REFUSES = [
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123,
  135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995,
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
];

describe('the port of a browser test part', () => {
  it.each([4180, 4300])('never takes a port the browser refuses, from base %i', base => {
    const refused = Array.from({ length: 5000 }, (_, pid) => browserPort(pid, base)).filter(port => CHROMIUM_REFUSES.includes(port));
    expect([...new Set(refused)]).toEqual([]);
  });

  it('stays in its range and gives every process of one cycle a port of its own', () => {
    const ports = Array.from({ length: 997 }, (_, pid) => browserPort(pid));
    expect(ports.every(port => port >= 4180 && port < 5180)).toBe(true);
    expect(new Set(ports).size).toBe(ports.length);
  });
});
