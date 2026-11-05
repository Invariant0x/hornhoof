/* Drizzle wraps driver errors, so the Postgres code can sit on the error or on its cause. */
export function hasCode(err: unknown, code: string): boolean {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === code) return true;
  }
  return false;
}

export function isUniqueViolation(err: unknown): boolean {
  return hasCode(err, '23505');
}
