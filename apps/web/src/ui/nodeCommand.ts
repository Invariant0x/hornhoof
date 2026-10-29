/* The command that starts a Hornhoof node on a person's machine and joins it to this server. */
export function nodeCommand(joinCode: string, server: string): string {
  return `docker run -d --name hornhoof-node --restart unless-stopped -v hornhoof-node:/data ghcr.io/invariant0x/hornhoof-node --server ${server} --join ${joinCode}`;
}
