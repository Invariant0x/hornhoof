// Read-only until the actual common admission and an equivalent adapter are reviewed.
export async function inspectReplayFixture(_root: string): Promise<{ status: string; measurement: string; formatter: string; files: { path: string; sha256: string }[] }> {
  throw new Error('Replay fixture audit is not implemented.');
}

export async function replayCommand(_args: string[], _root: string): Promise<unknown> {
  throw new Error('Replay command is not implemented.');
}
