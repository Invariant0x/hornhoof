export type Config = {
  databaseUrl?: string;
  secret: Buffer;
  publicUrl: string;
  port: number;
  secureCookies: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const raw = env.HORNHOOF_SECRET;
  if (!raw) throw new Error('HORNHOOF_SECRET is not set. Generate one with: openssl rand -base64 32');
  const secret = Buffer.from(raw, 'base64');
  if (secret.length !== 32) throw new Error('HORNHOOF_SECRET must be 32 bytes encoded as base64.');

  const publicUrl = (env.PUBLIC_URL || 'http://localhost:8080').replace(/\/+$/, '');
  return {
    databaseUrl: env.DATABASE_URL || undefined,
    secret,
    publicUrl,
    port: env.PORT ? Number(env.PORT) : 8080,
    secureCookies: publicUrl.startsWith('https://'),
  };
}
