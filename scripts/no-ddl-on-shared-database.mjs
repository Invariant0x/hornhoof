/* A truncate between tests empties the tables of a test file's one database and undoes nothing else, so a test that changes
   more than rows takes a database of its own, with ownDatabases() at the top of its file. */
const DDL = new RegExp([
  String.raw`\b(?:create|drop|alter)\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+|unique\s+|constraint\s+)?(?:table|trigger|function|procedure|role|index|view|type|schema|sequence|extension|policy)\b`,
  String.raw`\b(?:grant|revoke)\s+[a-z_", ]+\s+(?:on|to|from)\b`,
].join('|'), 'i');

const asksForOwn = statement => statement.type === 'ExpressionStatement'
  && statement.expression.type === 'CallExpression'
  && statement.expression.callee.name === 'ownDatabases';

/* Walks a chain like expect(x).not.resolves back to what it starts from. */
function startsAtExpect(node) {
  if (node.type === 'MemberExpression') return startsAtExpect(node.object);
  return node.type === 'CallExpression' && node.callee.name === 'expect';
}

/* A matcher's argument is what a test expects to read, not what it runs. What it hands to expect() may well run. */
const isExpectedText = ancestors => ancestors.some(node => node.type === 'CallExpression'
  && node.callee.type === 'MemberExpression' && startsAtExpect(node.callee.object));

export default {
  meta: {
    type: 'problem',
    docs: { description: 'DDL in a test on the database its file shares outlives the truncate between tests' },
    schema: [],
    messages: { ddl: 'A truncate does not undo DDL, so it would reach the next test. Call ownDatabases() at the top of this file.' },
  },
  create(context) {
    let own = false;
    const check = (node, text) => {
      if (own || !DDL.test(text) || isExpectedText(context.sourceCode.getAncestors(node))) return;
      context.report({ node, messageId: 'ddl' });
    };
    return {
      Program(program) { own = program.body.some(asksForOwn); },
      Literal(node) { if (typeof node.value === 'string') check(node, node.value); },
      TemplateElement(node) { check(node, node.value.cooked ?? ''); },
    };
  },
};
