/* A fast real clock for the hook clients' deadline tests; no network or ownership check is replaced. */
const timeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = () => timeout(150);
