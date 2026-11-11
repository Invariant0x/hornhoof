import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { SETTINGS } from './computer-strip-api';
import { serveRoutes } from './routes-api';

test.use({ reducedMotion: 'reduce' });
const SHOTS_DIR = 'e2e/results/outbound-shots';
mkdirSync(SHOTS_DIR, { recursive: true });

const MSG_REQ_ID = '11111111-1111-4111-8111-111111111111';
const APP_REQ_ID = '22222222-2222-4222-8222-222222222222';
const SALES_DECIDED_BY = { kind: 'owner_and_ceo' as const, department: { id: 'd2', name: 'Development' } };

const BOUND_MESSAGE = {
  kind: 'message' as const,
  requestId: MSG_REQ_ID,
  status: 'open',
  canAnswer: true,
  decidedBy: SALES_DECIDED_BY,
  channel: { id: 'ch-smtp', name: 'Sales Mail', adapter: 'smtp', purpose: 'first_contact', audience: 'direct' as const },
  account: { id: 'ac-smtp', label: 'Sales Primary', senderDomain: 'mail.acme.example', bindingGeneration: 2 },
  messageId: '44444444-4444-4444-8444-444444444444',
  revision: 1,
  locale: 'en',
  contentDigest: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  policyDigest: '4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a',
  sourceRevisionsDigest: 'ef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d',
  rendered: {
    subject: 'Quarterly enterprise plan overview',
    body: 'Plan price: $29.00\nDetails: https://acme.example/pricing/enterprise-plan-details-for-2026-audit',
  },
  sources: [
    { kind: 'template', entryId: 'tpl-1', revision: 3, summary: 'Quarterly enterprise plan overview' },
    { kind: 'price', entryId: 'prc-1', revision: 2, summary: '29.00 USD' },
    { kind: 'link', entryId: 'lnk-1', revision: 1, summary: 'https://acme.example/pricing/enterprise-plan-details-for-2026-audit' },
  ],
};

const BOUND_APPROACH = {
  kind: 'approach' as const,
  requestId: APP_REQ_ID,
  status: 'open',
  canAnswer: false,
  decidedBy: SALES_DECIDED_BY,
  channel: { id: 'ch-wh', name: 'Partner Webhook', adapter: 'webhook', purpose: 'support_reply', audience: 'direct' as const },
  segment: { id: 'seg-1', revision: 1, name: 'Verified partner contacts' },
  template: { id: 'tpl-2', revision: 2, locale: 'en', subject: 'Partner update', preview: 'Update details: [fact]' },
  policyDigest: '4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a',
  sourceRevisionsDigest: 'ef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d',
  sources: [{ kind: 'template', entryId: 'tpl-2', revision: 2, summary: 'Partner update' }],
};

const OVERVIEW = {
  channels: [
    {
      id: 'ch-smtp', departmentId: 'd2', productId: null, name: 'Sales Mail', adapter: 'smtp',
      purpose: 'first_contact', audience: 'direct' as const, status: 'active' as const, generation: 1, stoppedReason: null, stoppedAt: null,
      accounts: [{ id: 'ac-smtp', label: 'Sales Primary', senderDomain: 'mail.acme.example', status: 'active', configGeneration: 2, available: false }],
    },
    {
      id: 'ch-wh', departmentId: 'd2', productId: null, name: 'Partner Webhook', adapter: 'webhook',
      purpose: 'support_reply', audience: 'direct' as const, status: 'active' as const, generation: 1, stoppedReason: null, stoppedAt: null,
      accounts: [{ id: 'ac-wh', label: 'Webhook Endpoint', senderDomain: 'hooks.acme.example', status: 'active', configGeneration: 1, available: true }],
    },
  ],
  messages: [
    {
      id: '55555555-5555-4555-8555-555555555555', departmentId: 'd2', productId: null, taskId: 't1',
      channelId: 'ch-smtp', channelName: 'Sales Mail', accountId: 'ac-smtp', accountLabel: 'Sales Primary',
      senderDomain: 'mail.acme.example', revision: 1,
      contentDigest: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      status: 'unknown' as const, reasonCodes: ['delivery_unknown'],
      scheduledAt: '2026-11-06T12:00:00.000Z', updatedAt: '2026-11-06T12:02:00.000Z',
      unknownRecovery: {
        attemptId: '66666666-6666-4666-8666-666666666666',
        safeCode: 'timeout', endedAt: '2026-11-06T12:02:00.000Z',
        quotaHeld: true as const, nextActionCode: 'check_receiver_before_resend' as const,
      },
    },
  ],
  escalations: [
    {
      ticketId: 'TKT-77', revision: 1, departmentId: 'd2', productId: null, status: 'escalated',
      classId: 'refund_request', reasonCodes: ['requires_human'], requestId: MSG_REQ_ID, taskId: 't1',
      ownerPersonId: 'p2', canAnswer: false, decidedBy: SALES_DECIDED_BY, createdAt: '2026-11-06T12:00:00.000Z',
    },
  ],
  approvals: [BOUND_MESSAGE, BOUND_APPROACH],
};

async function serveOutbound(page: Page, decided: { approved: boolean }[]) {
  await serveRoutes(page);
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/outbound') {
      const approvals = decided.length ? [BOUND_APPROACH] : OVERVIEW.approvals;
      return route.fulfill({ json: { ...OVERVIEW, approvals } });
    }
    if (url.pathname === '/api/requests' && route.request().method() === 'GET') {
      return route.fulfill({
        json: {
          requests: decided.length ? [] : [{
            id: MSG_REQ_ID, kind: 'approval', text: 'Approve bound outbound message',
            commit: null, commitUrl: null, images: [], options: [], link: null, explained: null, explaining: false,
            at: '2026-11-06T12:00:00.000Z', agent: { id: 'b1', name: 'Bruno' },
            task: { id: 't1', number: 1, title: 'Checkout step 1', department: { id: 'd2', name: 'Development' }, product: null },
            ownerPersonId: 'p1', canAnswer: true, decidedBy: SALES_DECIDED_BY,
          }],
          proposals: [], computerAccess: [], counts: { byPerson: {}, byAgent: {}, total: decided.length ? 0 : 1 },
        },
      });
    }
    if (url.pathname === `/api/requests/${MSG_REQ_ID}/outbound-approval`) {
      return route.fulfill({ json: BOUND_MESSAGE });
    }
    if (url.pathname === `/api/requests/${MSG_REQ_ID}` && route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}') as { approve?: boolean };
      decided.push({ approved: !!body.approve });
      return route.fulfill({ json: { request: { id: MSG_REQ_ID, status: 'approved' } } });
    }
    return route.fallback();
  });
}

for (const settings of SETTINGS) {
  const { lang, theme, width } = settings;
  const t = lang === 'en' ? en : ru;
  test(`outbound approvals, unknown recovery, and bound requests ${lang} ${theme} ${width}`, async ({ page }) => {
    const decided: { approved: boolean }[] = [];
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(({ lang, theme }) => {
      localStorage.setItem('hh-lang', lang);
      localStorage.setItem('hh-theme', theme);
    }, settings);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
    await serveOutbound(page, decided);

    await page.goto('/tasks');
    await expect(page.getByRole('heading', { name: 'Quarterly enterprise plan overview' })).toBeVisible();
    await expect(page.getByText(/https:\/\/acme\.example\/pricing\/enterprise-plan-details-for-2026-audit/).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${SHOTS_DIR}/outbound-requests-${lang}-${theme}-${width}.png`, animations: 'disabled' });

    await page.getByRole('button', { name: t.shell.account, exact: true }).click();
    await page.getByRole('button', { name: t.shell.tabs.outbound, exact: true }).click();
    await expect(page).toHaveURL(/\/outbound$/);
    await expect(page.getByRole('heading', { name: t.outbound.heading, exact: true })).toBeVisible();
    await expect(page.getByText(new RegExp(t.outbound.unknownHeading))).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Partner Webhook', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${SHOTS_DIR}/outbound-overview-${lang}-${theme}-${width}.png`, animations: 'disabled' });

    await page.getByRole('button', { name: t.tasks.approve, exact: true }).click();
    await expect.poll(() => decided).toEqual([{ approved: true }]);
    await expect(page.getByText('Quarterly enterprise plan overview')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
