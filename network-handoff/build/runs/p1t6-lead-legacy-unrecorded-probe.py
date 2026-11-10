"""Check a foreign live legacy session with no route record, without printing credentials."""
import json
import sys
import tempfile

sys.path.insert(0, '/Users/0x/Projects/hornhoof-edge/relay/test')
from harness import Stack, _request, _wait

with tempfile.TemporaryDirectory(prefix='hornhoof-lead-legacy-') as tmp:
    with Stack(tmp) as stack:
        acme = stack.bind('acme')
        globex = stack.bind('globex')
        first = stack.client('globex', globex['key'])
        assert first.started('globex'), 'first legacy proxy did not start'
        second = stack.client('globex', globex['key'])
        assert _wait(lambda: 'router config conflict' in second.log(), 15), 'second legacy proxy was not refused'
        status, clients = stack.dash('/api/clients')
        status, route = stack.api('GET', '/api/v1/links/globex/route', key=globex['key'])
        # Both clients are legacy; the first owns the recorded route. The second stays online.
        import sqlite3
        with sqlite3.connect(stack.env['RELAY_DB']) as conn:
            recorded = conn.execute('SELECT run_id FROM routes WHERE name = ?', ('globex',)).fetchone()[0]
        others = [entry for entry in clients if entry['online'] and entry['clientID'] == entry['runID']
                  and entry['runID'] != recorded]
        assert len(others) == 1, 'unrecorded legacy session not found'
        content = {'metas': {'name': 'acme', 'key': acme['key']}, 'run_id': others[0]['runID']}
        status, raw = _request(stack.relay_port, 'POST', '/frp/handler',
                               json.dumps({'op': 'Login', 'content': content}).encode(),
                               {'Content-Type': 'application/json'})
        answer = json.loads(raw)
        print('Unrecorded foreign legacy Login rejected:', answer.get('reject'))
        assert answer.get('reject') is True, 'foreign unrecorded legacy session can be taken over'
