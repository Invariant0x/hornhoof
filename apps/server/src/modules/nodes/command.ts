/* The one command a person runs on their computer. The installer sets up Docker if needed, then the node. */
export const installCommand = (publicUrl: string, code: string): string => `curl -fsSL ${publicUrl}/install.sh | bash -s -- --join ${code}`;
