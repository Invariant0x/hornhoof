import { join } from 'node:path';
import type { ApiEndpoint, ProviderId, ServerMessage } from '@hornhoof/protocol';
import { ensurePasswd, isRootUser, prepareFolder, userFor, type FolderOps, type JobUser, type SystemFiles } from '../isolation.js';
import type { ProviderAdapter } from '../runner.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { kimiAdapter } from './kimi.js';
import { antigravityAdapter } from './antigravity.js';

/* api: where an API by the token at an address answers, and in which protocol, as its turn says. */
type Options = { home: string; tools: string; bin?: string; secret?: string | null; user?: JobUser | null; api?: ApiEndpoint | null };

/* OpenRouter and a compatible API run in the program of their protocol: Codex for OpenAI's, Claude Code for Anthropic's,
   which OpenRouter speaks unless its connection says otherwise. */
const speaksOpenAi = (provider: ProviderId, api?: ApiEndpoint | null) => (provider === 'openrouter' || provider === 'custom_api') && api?.protocol === 'openai';

/* The program each provider runs on: its file in tools/bin and the name people know it by. */
export function programFor(provider: ProviderId, api?: ApiEndpoint | null): { bin: 'claude' | 'codex' | 'kimi' | 'agy'; name: string } {
  if (provider === 'codex' || provider === 'openai_api' || speaksOpenAi(provider, api)) return { bin: 'codex', name: 'Codex' };
  if (provider === 'kimi') return { bin: 'kimi', name: 'Kimi Code' };
  if (provider === 'antigravity') return { bin: 'agy', name: 'Antigravity CLI' };
  return { bin: 'claude', name: 'Claude Code' };
}

/* A program of its maker's own knows where its maker answers. */
function own(opts: Options): Omit<Options, 'api'> {
  const { api, ...rest } = opts;
  void api;
  return rest;
}

/* bin overrides the program's path; tests point it at fake programs. */
export function adapterFor(provider: ProviderId, opts: Options): ProviderAdapter {
  switch (provider) {
    case 'claude':
      return claudeAdapter({ ...own(opts), mode: 'plan' });
    case 'anthropic_api':
      return claudeAdapter({ ...own(opts), mode: 'api_key' });
    case 'glm':
      return claudeAdapter({ ...own(opts), mode: 'glm' });
    case 'codex':
      return codexAdapter({ ...own(opts), mode: 'plan' });
    case 'openai_api':
      return codexAdapter({ ...own(opts), mode: 'api_key' });
    case 'kimi':
      return kimiAdapter(own(opts));
    case 'antigravity':
      return antigravityAdapter(own(opts));
    case 'openrouter':
    case 'custom_api': {
      const { api, ...rest } = opts;
      if (!api) return noAddress();
      return speaksOpenAi(provider, api) ? codexAdapter({ ...rest, mode: 'api_key', api }) : claudeAdapter({ ...rest, mode: 'api_key', api });
    }
  }
}

/* A turn of an API by address that came without it, from a server that does not send it: it fails with why, and its key
   never goes to another API. */
function noAddress(): ProviderAdapter {
  const output = 'This API connection came without the address it answers at. Update Hornhoof on the server.';
  return {
    install: async () => {},
    loggedIn: async () => true,
    login: async () => {},
    run: async () => ({ ok: false, sessionId: null, result: '', output, error: 'agent_failed', limits: null }),
    secrets: async () => [],
  };
}

type JobRun = Extract<ServerMessage, { type: 'job.run' }>;
type BuiltinOptions = { isRoot?: boolean; ops?: FolderOps; files?: SystemFiles };

/* The built-in node's adapter for a job: a user and home of its own for each agent, in agents/<key>, and for a key's test
   jobs in subs/<id>, and a work folder handed to that user. A company key needs no sign-in to share, so agents of one key
   never read each other's tool tokens. */
export function builtinAdapters(dir: string, tools: string, { isRoot = isRootUser(), ops, files }: BuiltinOptions = {}) {
  return (job: JobRun): ProviderAdapter => {
    const agent = job.workspace?.key ?? null;
    const user = userFor(dir, agent ? `agent:${agent}` : job.subscriptionId, isRoot);
    const home = prepareFolder(agent ? join(dir, 'agents', agent) : join(dir, 'subs', job.subscriptionId), user, ops);
    if (user) ensurePasswd(user, home, files);
    const adapter = adapterFor(job.provider, { home, tools, user, api: job.api ?? null });
    return {
      ...adapter,
      owner: { user, home, prepare: path => void prepareFolder(path, user, ops) },
      run: input => {
        prepareFolder(input.workDir, user, ops);
        return adapter.run(input);
      },
    };
  };
}
