/* All release commands report a useful error and a failing exit status. */
export function runCli(action) {
  try { process.stdout.write(action()); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
