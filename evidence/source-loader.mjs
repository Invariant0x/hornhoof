import { existsSync } from 'node:fs';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@hornhoof/protocol') {
    return { url: new URL('./protocol-stub.mjs', import.meta.url).href, shortCircuit: true };
  }
  if (specifier === 'zod') {
    return { url: new URL('./zod-stub.mjs', import.meta.url).href, shortCircuit: true };
  }
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
    const source = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    if (existsSync(source)) return { url: source.href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
