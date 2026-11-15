/* A count of tokens: whole below a million, and from there short, as millions and billions, so a busy day's count fits
   where a quiet one does. */
const SHORT_FROM = 1_000_000;
export const tokenCount = (language: string, n: number) =>
  new Intl.NumberFormat(language, n < SHORT_FROM ? undefined : { notation: 'compact', maximumFractionDigits: 1 }).format(n);
