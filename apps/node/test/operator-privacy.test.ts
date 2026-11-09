import { describe, expect, it } from 'vitest';
import { protectedOperatorContent } from '../src/terminal/operator-privacy.js';

describe('a protected program screen', () => {
  it.each([
    'Assigning the review to Rita and logging the result.',
    'Running verification of the changed tests: 12 passed.',
    'All conditions met, the wait ends.',
    'src/terminal/operator-privacy.ts  apps/server/src/modules/subscriptions/credentials.ts',
    'expect(add_api_key).toBeDefined(); const TEST_API_KEY = process.env.X;',
    'Upgrade the dependency to 5.2 and purchase nothing.',
    'The payments module keeps its totals; authenticatedSource(ctx, node) returns true.',
    'Telemetry spans are flushed after each request.',
    'Signing the release notes; loginHint stays empty.',
    'Ход идет, проверка входных данных прошла, условие цикла верно.',
  ])('is not a working screen of words that only look alike: %s', text => {
    expect(protectedOperatorContent(text)).toBe(false);
  });

  it.each([
    'Terms and conditions: accept?',
    'Accept the Terms of Service to continue',
    'Share telemetry data?',
    'Sign in with a password',
    'Sign-in required',
    'Please log in to continue',
    'Login with Google',
    'Enter the verification code we sent',
    'Sign in using device code 482917',
    'Your one-time code is 1234',
    'Two-factor authentication',
    'Payment and billing',
    'Add a payment method',
    'Upgrade your plan to keep going',
    'Scan the QR code',
    'API_KEY=abc and api key: def',
    'Authorization: Bearer abc',
    'access token: abc',
    'token=abc',
    'credentials:xyz',
    'Согласие на передачу данных',
    'Введите пароль',
    'Оплата и смена тарифа',
    'Войти через Google',
    'Вход в аккаунт',
    'Введите код подтверждения',
    'before [hidden] after',
  ])('is a screen of sign-in, consent, payment or a secret: %s', text => {
    expect(protectedOperatorContent(text)).toBe(true);
  });
});
