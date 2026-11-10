"""Probe stale DELETE authorization across a binding lifetime using only local HTTP."""
import hashlib
import http.client
from http.server import ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import tempfile
import threading

source = Path('/Users/0x/Projects/hornhoof-edge/relay/relay.py')
spec = importlib.util.spec_from_file_location('relay_delete_lifetime_probe', source)
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)
print('Source hash:', hashlib.sha256(source.read_bytes()).hexdigest()[:12])

with tempfile.TemporaryDirectory(prefix='hornhoof-lead-delete-') as tmp:
    relay.DB_PATH = str(Path(tmp) / 'relay.db')
    relay.CADDYFILE = '/Users/0x/Projects/hornhoof-edge/Caddyfile'
    relay.init_db()
    server = ThreadingHTTPServer(('127.0.0.1', 0), relay.Handler)
    server.daemon_threads = True
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()
    entered, resume = threading.Event(), threading.Event()
    hook_lock = threading.Lock()
    first = [True]
    original = relay.release_binding

    def pause_once(*args, **kwargs):
        with hook_lock:
            pause = first[0]
            first[0] = False
        if pause:
            entered.set()
            if not resume.wait(10):
                raise TimeoutError('probe release was not resumed')
        return original(*args, **kwargs)

    relay.release_binding = pause_once

    def api(method, path, key=None, body=None):
        conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
        headers = {}
        if key:
            headers['Authorization'] = f'Bearer {key}'
        data = None
        if body is not None:
            data = json.dumps(body)
            headers['Content-Type'] = 'application/json'
        try:
            conn.request(method, path, data, headers)
            response = conn.getresponse()
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
        finally:
            conn.close()

    old_result = []
    old_thread = None
    try:
        status, binding = api('POST', '/api/v1/bindings', body={'name': 'acme'})
        assert status == 201, 'initial local binding failed'

        def old_delete():
            status, _ = api('DELETE', '/api/v1/bindings/acme', key=binding['key'])
            old_result.append(status)

        old_thread = threading.Thread(target=old_delete, daemon=True)
        old_thread.start()
        assert entered.wait(3), 'old DELETE never reached its authorized release'
        second_status, _ = api('DELETE', '/api/v1/bindings/acme', key=binding['key'])
        assert second_status == 204, 'second local release failed'
        rebound_status, rebound = api('POST', '/api/v1/bindings', body={'name': 'acme'})
        assert rebound_status == 201, 'local rebind failed'
        resume.set()
        old_thread.join(5)
        assert not old_thread.is_alive(), 'old DELETE did not finish'
        survives = relay.db().execute('SELECT 1 FROM bindings WHERE name = ?', ('acme',)).fetchone() is not None
        print('Stale DELETE status:', old_result[0] if old_result else None,
              'new owner binding survives:', survives)
    finally:
        resume.set()
        if old_thread:
            old_thread.join(5)
        server.shutdown()
        server.server_close()
        serving.join(5)
        relay.db().close()

assert survives, 'a DELETE authorized for the old lifetime removed the new owner binding'
