#!/usr/bin/env node
// hh-xlsx INPUT OUTPUT.(xlsx|csv): builds a genuine .xlsx workbook or UTF-8 .csv table from JSON (array of objects,
// array of rows, or { sheets: [...] }), CSV or TSV, or "-" for stdin, using only built-in Node runtime libraries.
'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      text += chunk;
    });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const built = existsSync('/app/apps/node/dist/spreadsheet.js')
    ? '/app/apps/node/dist/spreadsheet.js'
    : join(__dirname, 'dist', 'spreadsheet.js');
  const { runSpreadsheetCli } = await import(pathToFileURL(built).href);
  const stdin = args[0] === '-' ? await readStdin() : undefined;
  const { out } = await runSpreadsheetCli(args, stdin);
  process.stdout.write(`${out}\n`);
}

main().catch(err => {
  process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
  process.exit(1);
});
