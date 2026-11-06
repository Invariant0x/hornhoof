/// <reference types="node" />
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

export type GeometryLabels = Record<'openOrchestrator' | 'title' | 'intro' | 'newNote' | 'placeholder' | 'add' | 'note' | 'change' | 'changeNote' | 'remove' | 'removeNote' | 'save' | 'cancel' | 'empty' | 'close' | 'full' | 'restore' | 'minimize' | 'notebook', string>;
export type GeometryLocale = { id: string; direction: 'ltr' | 'rtl'; score: number; labels: GeometryLabels };
export type GeometryBoot = {
  origin: string; session: string; sourceSha: string; author: string; note: string; number: number;
  department: { id: string; name: string; note: string; number: number };
  locales: GeometryLocale[]; selected: string[]; dictionaryKeys: string[]; scoreUnit: string; shippedRtl: boolean;
  dataSha256: string; fontsSha256: string; fontAssets: { name: string; bytes: number; sha256: string }[];
  localeKeys: Record<keyof GeometryLabels, string>; localeArguments: Partial<Record<keyof GeometryLabels, number[]>>;
};

export async function geometryServer(): Promise<GeometryBoot & { stop(): Promise<void> }> {
  if (!process.env.HH_GEOMETRY_SOURCE_ROOT || !process.env.HH_GEOMETRY_SOURCE_SHA) {
    throw new Error('NOT_RUN: geometry requires a pinned source checkout and the supported Docker/resource handoff; there is no host fallback');
  }
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./geometry-server.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const lines = createInterface({ input: child.stdout });
  const boot = await new Promise<GeometryBoot>((resolve, reject) => {
    lines.on('line', line => {
      if (line.startsWith('HH_GEOMETRY_BOOT ')) {
        try { resolve(JSON.parse(line.slice('HH_GEOMETRY_BOOT '.length)) as GeometryBoot); }
        catch (error) { reject(error); }
      }
    });
    child.once('error', reject);
    child.once('close', code => reject(new Error(`Geometry fixture closed before boot (${code}):\n${stderr}`)));
  });
  const stop = () => new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null) { lines.close(); resolve(); return; }
    child.once('close', code => { lines.close(); if (code === 0) resolve(); else reject(new Error(`Geometry fixture closed (${code}):\n${stderr}`)); });
    child.stdin.end();
  });
  return { ...boot, stop };
}
