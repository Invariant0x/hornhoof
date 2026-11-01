import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyRequest } from 'fastify';
import type { Ctx } from '../../app.js';
import type { IncidentMetadataResult, ProtectedInstallation } from './incident-metadata.js';

export type { IncidentMetadataResult, ProtectedInstallation } from './incident-metadata.js';

export type IncidentMetadataOperation = {
  invoke(request: FastifyRequest): Promise<IncidentMetadataResult>;
};

const outputBoundary = new AsyncLocalStorage<boolean>();
type StreamName = 'stdout' | 'stderr';
type Write = (typeof process.stdout)['write'];
const originals: Record<StreamName, Write> = {
  stdout: process.stdout.write,
  stderr: process.stderr.write,
};

const write = (name: StreamName, args: unknown[]): boolean => {
  if (outputBoundary.getStore()) {
    const callback = args.findLast(value => typeof value === 'function') as (() => void) | undefined;
    if (callback) queueMicrotask(callback);
    return true;
  }
  return originals[name].apply(process[name], args as never) as boolean;
};

const wrappers: Record<StreamName, Write> = {
  stdout: ((...args: unknown[]) => write('stdout', args)) as unknown as Write,
  stderr: ((...args: unknown[]) => write('stderr', args)) as unknown as Write,
};

function captureModuleAndDriverOutput(): void {
  for (const name of ['stdout', 'stderr'] as const) {
    if (process[name].write !== wrappers[name]) {
      originals[name] = process[name].write;
      process[name].write = wrappers[name];
    }
  }
}

export function createIncidentMetadataOperation(ctx: Ctx, installation: ProtectedInstallation, env: NodeJS.ProcessEnv): IncidentMetadataOperation {
  const trustedInstallation = Object.freeze({ ...installation });
  const trustedEnv = { ...env };
  return Object.freeze({
    async invoke(request: FastifyRequest): Promise<IncidentMetadataResult> {
      captureModuleAndDriverOutput();
      return outputBoundary.run(true, async () => {
        const { invokeIncidentMetadata } = await import('./incident-metadata.js');
        return invokeIncidentMetadata(ctx, trustedInstallation, trustedEnv, request);
      });
    },
  });
}
