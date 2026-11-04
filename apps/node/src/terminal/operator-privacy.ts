const protectedContent = /terms|conditions|consent|privacy|telemetry|data.?sharing|sign.?in|log.?in|password|verification|device.?code|one.time|two.factor|payment|billing|credit.card|purchase|upgrade|authenticat|oauth|access.?token|auth.?token|\btoken\s*:|api.?key|credential|qr.?code|authorization\s*[:=].{0,20}(?:bearer|basic)|услови|согласи|парол|войти|вход|код подтверж|оплат|тариф|передач.{0,25}данн/iu;

export function protectedOperatorContent(text: string): boolean {
  return text.includes('[hidden]') || protectedContent.test(text.replace(/\x1b\[[0-9;]*m/g, ''));
}
