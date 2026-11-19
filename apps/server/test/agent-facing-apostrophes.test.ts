import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { missingIn } from '../src/modules/tools/stumbles.js';

type Surface = { file: string; names?: readonly string[]; args?: Readonly<Record<string, number>> };

const surfaces: readonly Surface[] = [
  { file: 'briefings/briefing.ts', names: ['REPOSITORY_RULES'] },
  { file: 'calls/tools.ts', names: ['description'], args: { describe: 0 } },
  { file: 'conversation/first-contact.ts', names: ['WORDS', 'prompt'] },
  { file: 'merge/task.ts', args: { push: 0 } },
  { file: 'program-operator/tools.ts', names: ['description'] },
  { file: 'tasks/tools.ts', names: ['description'], args: { refuse: 2 } },
  { file: 'tasks/wake.ts', names: ['assignedPrompt', 'explanationText'] },
  { file: 'testruns/tools.ts', names: ['description'] },
  { file: 'tools/control.ts', args: { tool: 1 } },
  { file: 'tools/mcp.ts', names: ['description'] },
];

/* Check the literals that make each prompt, description or tool message, including the text around interpolations. */
function agentText(surface: Surface): { source: ts.SourceFile; literals: (ts.StringLiteralLike | ts.TemplateLiteralToken)[] } {
  const input = readFileSync(new URL(`../src/modules/${surface.file}`, import.meta.url), 'utf8');
  const source = ts.createSourceFile(surface.file, input, ts.ScriptTarget.Latest);
  const literals: (ts.StringLiteralLike | ts.TemplateLiteralToken)[] = [];
  function collect(node: ts.Node): void {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) literals.push(node);
    node.forEachChild(collect);
  }
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isPropertyAssignment(node)) {
      if (node.name && ts.isIdentifier(node.name) && surface.names?.includes(node.name.text)) {
        collect(node);
        return;
      }
    }
    if (ts.isCallExpression(node) && surface.args) {
      const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
      const index = ts.isIdentifier(name) && Object.hasOwn(surface.args, name.text) ? surface.args[name.text] : undefined;
      const argument = index === undefined ? undefined : node.arguments[index];
      if (argument) collect(argument);
    }
    node.forEachChild(visit);
  }
  visit(source);
  return { source, literals };
}

describe('apostrophes in text shown to agents', () => {
  it.each(surfaces)('uses plain apostrophes in $file', surface => {
    const { source, literals } = agentText(surface);
    expect(literals.length).toBeGreaterThan(0);
    const smart = literals.flatMap(node => {
      if (!/[\u2018\u2019]/.test(node.text)) return [];
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      return [`${surface.file}:${line + 1}`];
    });
    expect(smart).toEqual([]);
  });

  it('still recognizes quoted shell output in tools/stumbles.ts', () => {
    expect(missingIn('/usr/bin/env: \u2018sample-command\u2019: No such file or directory')).toEqual([
      { what: 'sample-command', kind: 'command' },
    ]);
  });
});
