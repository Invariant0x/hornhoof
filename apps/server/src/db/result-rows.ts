/* Raw SQL returns an array in some drivers and a result with rows in others. */
export const rowsOf = <T>(answer: unknown): T[] => (Array.isArray(answer) ? answer : (answer as { rows: T[] }).rows);
