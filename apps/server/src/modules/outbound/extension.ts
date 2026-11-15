import type { Ctx } from '../../app.js';
import { modelCheckRound } from '../model-checks/store.js';
import { outboundReviewRound, outboundRound } from './dispatcher.js';
import { certifyPassed, liveEvaluator } from './live-checks.js';

/* The one door into outbound and the model checks it runs: the rest of the server imports nothing else of these two
   modules, and a lint rule holds it to that. Through it go their routes, the tools agents get, what a department that is
   removed still holds here, and their part of the minute round. */
export { outboundRoutes } from './routes.js';
export { modelCheckRoutes } from '../model-checks/routes.js';
export { registerOutboundTools } from './tools.js';
export { registerOutboundControlTools } from './tools-control.js';
export { registerOutboundHeadTools } from './tools-head.js';
export { outboundRecordsOf } from './policies.js';
export { reconcileOutbound } from './dispatcher.js';
/* Which addresses are on the public internet: an API's model list at an address a person gave is asked only there. */
export { isPublicAddress } from './webhook.js';

/* What the minute round does here, each with what to say when it fails. */
export const outboundRounds = (ctx: Ctx, now: Date): [Promise<unknown>, string][] => [
  [modelCheckRound(ctx, now, liveEvaluator(ctx), certifyPassed(ctx)), 'running model checks failed'],
  [outboundReviewRound(ctx, now), 'checking waiting outbound messages failed'],
  [outboundRound(ctx, now), 'sending outbound messages failed'],
];
