"""Probe the malformed NewProxy run-id refusal without printing credentials."""
import json
from pathlib import Path
import sqlite3
import sys
import tempfile

sys.path.insert(0, '/Users/0x/Projects/hornhoof-edge/relay/test')
from harness import Stack, _request

with tempfile.TemporaryDirectory(prefix='hornhoof-lead-id-') as tmp:
    with Stack(tmp) as stack:
        binding = stack.bind('acme')
        content = {'user': {'metas': {'name': 'acme', 'key': binding['key'],
                                     'client': 'acme-1234abcd-link'}, 'run_id': []},
                   'proxy_name': 'acme', 'proxy_type': 'http', 'subdomain': 'acme'}
        status, raw = _request(stack.relay_port, 'POST', '/frp/handler',
                               json.dumps({'op': 'NewProxy', 'content': content}).encode(),
                               {'Content-Type': 'application/json'})
        answer = json.loads(raw)
        with sqlite3.connect(Path(tmp) / 'relay.db') as conn:
            row = conn.execute('SELECT generation, run_id FROM routes WHERE name = ?', ('acme',)).fetchone()
        print('HTTP:', status, 'rejected:', answer.get('reject'),
              'generation:', row[0] if row else None, 'empty run id stored:', row is not None and row[1] == '')
        assert answer.get('reject') is True and row is None, 'malformed identity was accepted and changed a route'
