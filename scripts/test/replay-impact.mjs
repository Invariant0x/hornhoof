/* Standalone reporting port. Production280/222 integration is separate. */
process.stdout.write(JSON.stringify({ version: 1, status: 'blocked', rows: [] }) + '\n');
process.exitCode = 3;
