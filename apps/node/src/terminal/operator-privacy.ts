/* What a program shows when it asks its owner to sign in, consent, pay or give a secret. Each is a whole word or phrase: a
   working screen that names files, code or checks with words that only contain these is not one. */
const phrases = [
  'terms (?:of (?:service|use)|and conditions)', 'privacy (?:policy|notice|settings)', 'consent',
  '(?:share|send) (?:\\p{L}+ )?(?:telemetry|usage data|crash reports)', 'telemetry (?:data|consent|settings)', 'data[ -]?sharing',
  'sign[ -]?(?:in|up)', 'log[ -]?in', 'password', 'passcode', 'passphrase',
  'verification code', "verify (?:your|it'?s you)", 'device code', 'one[ -]time (?:code|password|passcode)', 'two[ -]factor', '2fa', 'mfa', 'qr code',
  'payment (?:method|details|information|required)', 'billing', 'credit card', 'add (?:a )?card',
  'purchase (?:a |the )?(?:plan|subscription|credits)', 'upgrade (?:your |to |the )?(?:plan|subscription|account|pro|premium|ultra)', 'subscribe to',
  'authenticate (?:with|to|your)', 'authentication (?:required|failed|code)', 're-?authenticate', 'oauth',
  '(?:access|auth|refresh)[ _-]?token', '(?:api|secret|private)[ _-]?key', 'client[ _-]?secret', 'token(?=\\s*[:=])', 'credentials?(?=\\s*[:=])',
  'authorization\\s*[:=].{0,20}(?:bearer|basic)',
  'услови[ея] (?:использования|соглашения|обслуживания)', 'пользовательск\\p{L}* соглашени\\p{L}*', 'согласи[еяю]', 'парол\\p{L}*', 'войти',
  'вход(?:а|е|у|ом)?', 'код\\p{L}* подтвержд\\p{L}*', 'оплат\\p{L}*', 'тариф\\p{L}*', 'передач\\p{L}* .{0,25}данн\\p{L}*',
];
const protectedContent = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${phrases.join('|')})(?![\\p{L}\\p{N}_])`, 'iu');

export function protectedOperatorContent(text: string): boolean {
  return text.includes('[hidden]') || protectedContent.test(text.replace(/\x1b\[[0-9;]*m/g, ''));
}
