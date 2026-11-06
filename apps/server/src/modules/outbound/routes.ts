import { OutboundPolicyValue, OutboundSubmit } from '@hornhoof/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf } from '../../auth/access.js';
import { actsAsCeo } from '../../auth/decisions.js';
import { requirePerson, type Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { ApiError } from '../../errors.js';
import { mayChangeRules, ownDepartment } from '../departments/approval-policy.js';
import { jobOf } from '../tools/job.js';
import { catalogRow, proposeRevision, ProposalInput, publishRevision, requireProductOf, revokeRevision } from './catalog.js';
import { digestOf } from './checks.js';
import { addContact, permissionPlace, readUnsubscribeToken, revokePermission, suppressContact, unsubscribe } from './contacts.js';
import { outboundStatus, submitOutbound } from './core.js';
import { addPolicy, channelIn, createChannel, reopenChannel, stopByPerson, type Channel } from './policies.js';
import { authorityOf } from './tools.js';

/* The gateway over HTTP. An agent submits and reads with its job's token, through the same kernel as its tools. A person sets
   up what a message can be made of. The one way in for outsiders is the stop link of a message. No route here reaches a
   transport: the dispatcher does, by itself, through the kernel's last look. */

const IdParams = z.strictObject({ id: z.uuid() });
/* A signed link is longer than the router takes a named part of a path to be, so it is the rest of the path. */
const TokenParams = z.object({ '*': z.string().min(1).max(1000) });
const Name = z.string().trim().min(1).max(200);
const Evidence = z.string().trim().min(1).max(2000);
const ChannelBody = z.strictObject({ departmentId: z.uuid(), productId: z.uuid().optional(), name: Name, adapter: z.enum(['smtp', 'webhook']), purpose: Name, audience: z.enum(['direct', 'public']) });
const ContactBody = z.strictObject({ channelId: z.uuid(), kind: z.enum(['email', 'direct']), address: z.string().min(1).max(320), source: Name, evidence: Evidence });
const SuppressBody = z.strictObject({ evidence: Evidence });

const idOf = (req: FastifyRequest): string => IdParams.parse(req.params).id;
const notYours = (message: string) => new ApiError(403, 'forbidden', message, 'outbound_not_allowed');
const channelView = ({ id, status, generation }: Channel) => ({ channelId: id, status, generation });
const logged = (req: FastifyRequest, me: Person, what: object) => req.log.info({ ...what, personId: me.id, viaAgent: me.via ?? null }, 'outbound setup changed');

async function requireManager(db: Db, me: Person, departmentId: string): Promise<void> {
  if (!(await mayChangeRules(db, me, departmentId))) throw notYours('Only this department\'s owner, the CEO or the CEO delegate does this.');
}

const manageChannel = async (ctx: Ctx, me: Person, id: string): Promise<Channel> => {
  const channel = await channelIn(ctx.db, me.companyId, id);
  await requireManager(ctx.db, me, channel.departmentId);
  return channel;
};

const manageRevision = async (ctx: Ctx, me: Person, id: string) => {
  const row = await catalogRow(ctx.db, me.companyId, id);
  await requireManager(ctx.db, me, row.departmentId);
  return row;
};

function channelRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  app.post('/api/outbound/channels', async req => {
    const me = await requirePerson(req, db);
    const body = ChannelBody.parse(req.body);
    const dept = await ownDepartment(db, me.companyId, body.departmentId);
    await requireManager(db, me, dept.id);
    await requireProductOf(db, { ...body, companyId: me.companyId });
    const channel = await createChannel(db, { ...body, companyId: me.companyId, productId: body.productId ?? null, createdBy: me.id });
    logged(req, me, { channelId: channel.id, did: 'created' });
    return channelView(channel);
  });

  app.post('/api/outbound/channels/:id/policies', async req => {
    const me = await requirePerson(req, db);
    const channel = await manageChannel(ctx, me, idOf(req));
    const policy = await addPolicy(ctx, { companyId: me.companyId, channelId: channel.id, createdBy: me.id }, OutboundPolicyValue.parse(req.body));
    logged(req, me, { channelId: channel.id, did: 'policy', revision: policy.revision });
    return policy;
  });

  app.post('/api/outbound/channels/:id/stop', async req => {
    const me = await requirePerson(req, db);
    const channel = await manageChannel(ctx, me, idOf(req));
    const stopped = await stopByPerson(ctx, channel.id);
    logged(req, me, { channelId: channel.id, did: 'stopped' });
    return channelView(stopped);
  });

  app.post('/api/outbound/channels/:id/reopen', async req => {
    const me = await requirePerson(req, db);
    const channel = await manageChannel(ctx, me, idOf(req));
    const reopened = await reopenChannel(ctx, { companyId: me.companyId, channelId: channel.id });
    logged(req, me, { channelId: channel.id, did: 'reopened' });
    return channelView(reopened);
  });
}

function catalogRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  app.post('/api/outbound/catalog', async req => {
    const me = await requirePerson(req, db);
    const input = ProposalInput.parse(req.body);
    const dept = await ownDepartment(db, me.companyId, input.departmentId);
    await requireManager(db, me, dept.id);
    return proposeRevision(ctx, { ...input, companyId: me.companyId, author: me.via ? { kind: 'agent', id: me.via } : { kind: 'person', id: me.id } });
  });

  /* A model, even for the person its turn answers, never makes its own words sendable. */
  app.post('/api/outbound/catalog/:id/publish', async req => {
    const me = await requirePerson(req, db);
    if (me.via) throw notYours('Only a person publishes what a message may say.');
    const row = await manageRevision(ctx, me, idOf(req));
    const published = await publishRevision(db, row, me.id);
    logged(req, me, { revisionId: row.id, did: 'published' });
    return published;
  });

  app.post('/api/outbound/catalog/:id/revoke', async req => {
    const me = await requirePerson(req, db);
    const row = await manageRevision(ctx, me, idOf(req));
    const revoked = await revokeRevision(db, row);
    logged(req, me, { revisionId: row.id, did: 'revoked' });
    return revoked;
  });
}

function contactRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  app.post('/api/outbound/contacts', async req => {
    const me = await requirePerson(req, db);
    const body = ContactBody.parse(req.body);
    const channel = await manageChannel(ctx, me, body.channelId);
    return addContact(ctx, { ...body, companyId: me.companyId, channel });
  });

  /* Contacts are the company's. A refusal only ever writes less, so any department's owner may record it. */
  app.post('/api/outbound/contacts/:id/suppress', async req => {
    const me = await requirePerson(req, db);
    const contactId = idOf(req);
    if (!actsAsCeo(me) && !(await accessOf(db, me)).owns?.size) throw notYours('Only a department\'s owner, the CEO or the CEO delegate does this.');
    await suppressContact(ctx, { companyId: me.companyId, contactId, evidenceDigest: digestOf(SuppressBody.parse(req.body).evidence) });
    logged(req, me, { contactId, did: 'suppressed' });
    return { contactId, doNotContact: true };
  });

  app.post('/api/outbound/permissions/:id/revoke', async req => {
    const me = await requirePerson(req, db);
    const permissionId = idOf(req);
    await requireManager(db, me, (await permissionPlace(db, me.companyId, permissionId)).departmentId);
    await revokePermission(ctx, { companyId: me.companyId, permissionId });
    return { permissionId, status: 'revoked' };
  });
}

/* Two languages side by side, as whoever gets a message has no account here to choose one in. Nothing on it comes from anyone. */
const page = (english: string, russian: string, rest = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${english}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1rem}</style></head><body><p>${english}</p><p lang="ru">${russian}</p>${rest}</body></html>`;
const ASKING = page('Stop these messages?', 'Больше не присылать эти сообщения?', '<form method="post"><button type="submit">Stop these messages / Больше не присылать</button></form>');
const DONE = page('You will get no more messages from us.', 'Сообщений больше не будет.');

const answerPage = (reply: FastifyReply, html: string) =>
  reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').header('x-robots-tag', 'noindex').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'").type('text/html; charset=utf-8').send(html);

const noSuchLink = () => new ApiError(404, 'not_found', 'This link does not work.', 'outbound_unknown');

function openUnsubscribe(ctx: Ctx, req: FastifyRequest): string {
  const token = TokenParams.parse(req.params)['*'];
  if (!readUnsubscribeToken(ctx.config.secret, token)) throw noSuchLink();
  return token;
}

/* A mail program opens every link in a message, so opening one changes nothing: a person presses the button, or a mail
   program sends the one-click request it was told about. Both post a form, which no other route takes. */
function unsubscribeRoutes(app: FastifyInstance, ctx: Ctx): void {
  void app.register(async scope => {
    scope.addContentTypeParser(['application/x-www-form-urlencoded', 'multipart/form-data'], { parseAs: 'string', bodyLimit: 1024 }, (_req, _body, done) => done(null, undefined));
    scope.get('/api/outbound/unsubscribe/*', async (req, reply) => {
      openUnsubscribe(ctx, req);
      return answerPage(reply, ASKING);
    });
    scope.post('/api/outbound/unsubscribe/*', async (req, reply) => {
      const token = openUnsubscribe(ctx, req);
      if (!(await unsubscribe(ctx, token))) throw noSuchLink();
      return answerPage(reply, DONE);
    });
  });
}

function agentRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.post('/api/outbound/messages', async req => {
    const job = await jobOf(ctx, req);
    return submitOutbound(ctx, authorityOf(job), OutboundSubmit.parse(req.body));
  });

  app.get('/api/outbound/messages/:id', async req => {
    const job = await jobOf(ctx, req);
    return outboundStatus(ctx, authorityOf(job), idOf(req));
  });
}

export function outboundRoutes(app: FastifyInstance, ctx: Ctx): void {
  agentRoutes(app, ctx);
  channelRoutes(app, ctx);
  catalogRoutes(app, ctx);
  contactRoutes(app, ctx);
  unsubscribeRoutes(app, ctx);
}
