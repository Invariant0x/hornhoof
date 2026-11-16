/* How long the slots a copy named in its report are dropped by: it reports every 20 seconds, and a table it named may have
   started again since a report that is older than this. */
export const LEFT_SLOTS_FRESH_MS = 120_000;

/* The leader's slots of tables whose first copy broke off, as each copy named them in its last report, for the leader's
   own keeper to drop at its next sweep. The app keeps them in memory only: a copy names them again with each report. */
export class LeftSlots {
  private readonly said = new Map<string, { slots: string[]; at: number }>();

  /* What a copy named in a report, in place of what it named before; a report that names none clears them. */
  say(machine: string, slots: string[] | undefined, at = Date.now()): void {
    this.said.set(machine, { slots: slots ?? [], at });
  }

  /* What the copies named in reports that are still fresh; older ones are forgotten. */
  now(at = Date.now()): string[] {
    for (const [machine, said] of this.said) if (at - said.at > LEFT_SLOTS_FRESH_MS) this.said.delete(machine);
    return [...this.said.values()].flatMap(said => said.slots);
  }
}
