/* Ports a browser will not open (net::ERR_UNSAFE_PORT), as Chromium's port_util lists them; Firefox and WebKit refuse the same. */
const REFUSED = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123,
  135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995,
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/* The port a test part's dev server takes on a machine it shares with other parts: one of the span that a browser opens. */
export function browserPort(pid: number, base = 4180, span = 1000): number {
  const open = Array.from({ length: span }, (_, i) => base + i).filter(port => !REFUSED.has(port));
  return open[pid % open.length]!;
}
