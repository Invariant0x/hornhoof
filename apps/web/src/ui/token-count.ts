/* A count of tokens as the person's language writes a whole number. */
export const tokenCount = (language: string, n: number) => new Intl.NumberFormat(language).format(n);
