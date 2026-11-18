/* Whether the machine ran out of memory since the node's report before: its kernel killed a process for want of it, as its
   count of such kills grew. A machine that starts again counts from zero, so a count lower than the last one is no kill,
   and neither is the first one a node reads; where the count cannot be read the machine is never short. While it is,
   Hornhoof starts no new agent program there and the node starts no one-shot call, until a report finds no new kill; what
   runs there goes on. No figure of Hornhoof's own decides it, only what the machine did. */
export class MemoryShort {
  private last: number | undefined;
  private short = false;

  /* A report's reading of the count: whether it grew since the reading before. */
  report(kills: number | undefined): boolean {
    this.short = kills !== undefined && this.last !== undefined && kills > this.last;
    this.last = kills;
    return this.short;
  }

  /* What the last report found. */
  get now(): boolean {
    return this.short;
  }
}
