import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { decryptSecret } from '../../crypto/secrets.js';
import { googleSheets } from '../../db/schema.js';
import type { ToolJob } from '../tools/job.js';
import type { StoredGoogleSecret } from './sheets.js';

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

const CellValue = z.union([z.string().max(32_000), z.number().finite(), z.boolean(), z.null()]);
const SheetInput = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  headers: z.array(z.string().max(1_000)).max(200).optional(),
  rows: z.array(z.array(CellValue).max(200)).max(10_000),
});

const NOT_CONNECTED = {
  connected: false,
  setup:
    'Google Sheets is not connected for this company yet. A person who sees the whole company can connect a Google service account or OAuth JSON key in Company settings -> Google Sheets.',
  fallback:
    'Do not refuse the request: tell the person plainly what needs to be connected in Company settings -> Google Sheets, and right now generate a ready .xlsx file with hh-xlsx and attach it with hh-attach (--task N and/or --chat).',
};

export function registerGoogleSheetsTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  server.registerTool(
    'create_google_sheet',
    {
      description:
        'Creates a populated Google Sheet and returns its link when Google Sheets is connected for the company. ' +
        'If Google Sheets is not connected, returns { connected: false, setup, fallback } so you can explain what to connect in Company settings and immediately attach a ready .xlsx with hh-xlsx and hh-attach.',
      inputSchema: {
        title: z.string().trim().min(1).max(200).describe('Title of the new Google spreadsheet.'),
        sheets: z.array(SheetInput).min(1).max(20).describe('Worksheets with optional column headers and literal cell rows.'),
      },
    },
    async ({ title, sheets }) => {
      const [row] = await ctx.db.select().from(googleSheets).where(eq(googleSheets.companyId, job.companyId));
      if (!row) return say(JSON.stringify(NOT_CONNECTED));
      let secret: StoredGoogleSecret;
      try {
        secret = JSON.parse(decryptSecret(row.credentialsEnc, ctx.config.secret)) as StoredGoogleSecret;
      } catch {
        return say('The saved Google Sheets key could not be opened. Ask a person with whole-company access to save it again in Company settings, and attach a ready .xlsx with hh-xlsx and hh-attach now.', true);
      }
      const result = await ctx.createSpreadsheet({ ...secret, shareEmail: row.shareEmail }, { title, sheets });
      if ('problem' in result) {
        return say(`${result.problem} Generate and attach a ready .xlsx right now with hh-xlsx and hh-attach so the person still receives the spreadsheet.`, true);
      }
      return say(JSON.stringify({ connected: true, spreadsheetId: result.spreadsheetId, url: result.url, title }));
    },
  );
}
