/* Waits for a state, not for a moment: it looks until the check holds, and once more after its time is up, as a slow look on
   a busy machine can outlast that time. */
export async function eventually(check, { ms = 15_000, every = 20, message = 'The state the test waits for did not come.' } = {}) {
  for (const end = Date.now() + ms; ; await new Promise(resolve => { setTimeout(resolve, every); })) {
    const late = Date.now() >= end;
    if (await check()) return;
    if (late) throw new Error(message);
  }
}
