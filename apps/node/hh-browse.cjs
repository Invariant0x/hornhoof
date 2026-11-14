#!/usr/bin/env node
// hh-browse URL: an agent of any department reads a public page in the node's own browser, its text, its links and a
// screenshot, and hears when a sign-in or a robot check stands in the way. hh-browse --help lists the options and limits.
// The command is built with the node: in the image it lives in /app/apps/node/dist, beside a clone in ./dist.
'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const beside = join(__dirname, 'dist', 'web-page', 'cli.js');
const command = existsSync(beside) ? beside : '/app/apps/node/dist/web-page/cli.js';

import(pathToFileURL(command).href)
  .then(cli => cli.run(process.argv.slice(2)))
  .catch(err => {
    process.stderr.write(`hh-browse: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(1);
  });
