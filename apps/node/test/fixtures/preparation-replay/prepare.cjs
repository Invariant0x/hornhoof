const fs = require('node:fs');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const expected = () => ({
  dependency: require('replay-value'),
  protocol: hash(fs.readFileSync('protocol-source.txt')),
  migration: hash(fs.readFileSync('migration.sql')),
  payload: hash(Buffer.alloc(1024 * 1024, 0x5a)),
});
switch (process.argv[2]) {
  case 'build':
    fs.mkdirSync('protocol/dist', { recursive: true });
    fs.writeFileSync('protocol/dist/index.json', JSON.stringify({ source: hash(fs.readFileSync('protocol-source.txt')) }));
    break;
  case 'environment': {
    const protocol = JSON.parse(fs.readFileSync('protocol/dist/index.json', 'utf8'));
    if (protocol.source !== hash(fs.readFileSync('protocol-source.txt'))) throw new Error('Generated protocol is stale.');
    fs.mkdirSync('template', { recursive: true });
    fs.writeFileSync('template/payload.bin', Buffer.alloc(1024 * 1024, 0x5a));
    fs.writeFileSync('template/ready.json', JSON.stringify(expected()));
    break;
  }
  case 'ready': {
    const protocol = JSON.parse(fs.readFileSync('protocol/dist/index.json', 'utf8'));
    const ready = JSON.parse(fs.readFileSync('template/ready.json', 'utf8'));
    const want = expected();
    if (want.dependency !== 'dependency-v1' || protocol.source !== want.protocol) throw new Error('Dependency/protocol readiness failed.');
    if (JSON.stringify(ready) !== JSON.stringify(want)) throw new Error('Template readiness failed.');
    if (hash(fs.readFileSync('template/payload.bin')) !== want.payload) throw new Error('Template bytes differ.');
    console.log(JSON.stringify({ kind: 'readiness', ...ready }));
    break;
  }
  default:
    throw new Error('Use build, environment or ready.');
}
