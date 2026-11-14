export type SpreadsheetCell = string | number | boolean | null | undefined;

export type SpreadsheetSheet = {
  name?: string;
  headers?: string[];
  rows: SpreadsheetCell[][];
};

export type SpreadsheetInput =
  | Record<string, unknown>[]
  | SpreadsheetCell[][]
  | { sheets: (SpreadsheetSheet | { name?: string; rows: Record<string, unknown>[] })[] };

export function parseTableInput(raw: string, sourceName?: string): SpreadsheetSheet[] {
  void raw;
  void sourceName;
  throw new Error('not implemented');
}

export function buildCsv(sheet: SpreadsheetSheet): string {
  void sheet;
  throw new Error('not implemented');
}

export function buildXlsx(sheets: SpreadsheetSheet[]): Buffer {
  void sheets;
  throw new Error('not implemented');
}

export async function runSpreadsheetCli(args: string[], stdin?: string): Promise<{ out: string }> {
  void args;
  void stdin;
  throw new Error('not implemented');
}
