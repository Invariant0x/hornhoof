/* The event loop's own turn, taken when this file loads, so a test's fake clock never stops a wait. */
const turn = setImmediate;

/* Waits for a state, not for a moment: it looks again after every turn of the event loop, with no timer and no deadline, so
   no verdict rests on how fast or how busy the machine is. A state that never comes ends at the runner's limit for the whole
   test. */
export async function eventually(check) {
  while (!(await check())) await new Promise(resolve => { turn(resolve); });
}
