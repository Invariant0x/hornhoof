import type { Ctx } from '../../app.js';

/* What Hornhoof does for assistants while it runs: it collects what agents answer them, tells them of the requests that wait
   for their owners, and wakes them when something new is there. */
export class Assistants {
  constructor(private readonly ctx: Ctx) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  /* Something an assistant waits for may have happened in this company. */
  collect(companyId: string): void {
    void companyId;
    void this.ctx;
  }
}
