"""Only a live route's holder may persist a newer sync record: R2.4."""

from concurrent.futures import ThreadPoolExecutor
import http.client
import json
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

if __package__:
    from .harness import Client, Stack, _request, _wait, load_relay_module
else:
    from harness import Client, Stack, _request, _wait, load_relay_module


MISSING = {'state': 'off', 'copy': None, 'epoch': 0, 'generation': 0, 'at': None}
POST = {'client': 'acme-aaaaaaaa-link', 'generation': 1, 'state': 'on',
        'copy': 'bbbbbbbb', 'epoch': 1}


class SyncTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-sync-'))
        self.stack = self.enterContext(Stack(self.tmp))
        self.binding = self.stack.bind('acme')
        self.key = self.binding['key']

    def route(self) -> dict:
        status, body = self.stack.api('GET', '/api/v1/links/acme/route', key=self.key)
        self.assertEqual(status, 200, body)
        return body

    def post(self, **changes: object) -> tuple[int, dict | None]:
        return self.stack.api('POST', '/api/v1/links/acme/sync', POST | changes, key=self.key)

    def holder(self) -> Client:
        client = self.stack.client('acme', self.key, settings='network', client=POST['client'])
        self.assertTrue(client.started('acme'), client.log())
        route = self.route()
        self.assertEqual((route['state'], route['client'], route['generation']),
                         ('held', 'acme-aaaaaaaa-link', 1))
        return client

    def stored(self, stack: Stack | None = None) -> tuple | None:
        active = self.stack if stack is None else stack
        with sqlite3.connect(f"file:{active.env['RELAY_DB']}?mode=ro", uri=True) as conn:
            return conn.execute('SELECT state, copy, epoch, generation, at FROM sync '
                                "WHERE name = 'acme'").fetchone()

    def test_r2_4_missing_reads_off(self) -> None:
        self.assertEqual(self.route()['sync'], MISSING)

    def test_r2_4_holder_sets_it(self) -> None:
        self.holder()
        before = int(time.time())
        status, body = self.post()
        self.assertEqual(status, 200, body)
        record = body['sync']
        self.assertEqual(record, {'state': 'on', 'copy': 'bbbbbbbb', 'epoch': 1,
                                  'generation': 1, 'at': record['at']})
        self.assertIs(type(record['at']), int)
        self.assertGreaterEqual(record['at'], before)
        self.assertLessEqual(record['at'], int(time.time()))
        self.assertEqual(self.route()['sync'], record)
        status, body = self.post(state='off', copy=None, epoch=2)
        self.assertEqual(status, 200, body)
        self.assertEqual(body['sync'], {'state': 'off', 'copy': None, 'epoch': 2,
                                        'generation': 1, 'at': body['sync']['at']})
        self.assertEqual(self.route()['sync'], body['sync'])

    def test_r2_4_a_lone_surrogate_answers_invalid(self) -> None:
        self.holder()
        status, body = self.post(copy='\ud800')
        self.assertEqual((status, body['error']), (400, 'invalid'), body)

    def test_r2_4_others_refused(self) -> None:
        client = self.holder()
        status, body = self.post()
        self.assertEqual(status, 200, body)
        saved = body['sync']
        for changes, error in (({'client': 'acme-cccccccc-link', 'epoch': 2}, 'not_holder'),
                               ({'generation': 2, 'epoch': 2}, 'not_holder'),
                               ({}, 'stale_epoch')):
            with self.subTest(changes=changes):
                status, body = self.post(**changes)
                self.assertEqual(status, 409, body)
                self.assertEqual(body['error'], error)
                self.assertEqual(self.route()['sync'], saved)
        client.stop()
        self.assertTrue(_wait(lambda: self.route()['state'] == 'empty', 5))
        status, body = self.post(epoch=2)
        self.assertEqual(status, 409, body)
        self.assertEqual(body['error'], 'not_holder')
        self.assertEqual(self.route()['sync'], saved)

    def test_r2_4_pending_is_not_held(self) -> None:
        binding = self.stack.bind('globex')
        with sqlite3.connect(self.stack.env['RELAY_DB']) as conn:
            conn.execute('INSERT INTO routes VALUES (?, ?, ?, ?, ?, ?, ?)',
                         ('globex', 1, 'globex-aaaaaaaa-link', 'r1', 'http', 'pending', int(time.time())))
        status, route = self.stack.api('GET', '/api/v1/links/globex/route', key=binding['key'])
        self.assertEqual(status, 200, route)
        self.assertEqual(route['state'], 'held')
        status, body = self.stack.api('POST', '/api/v1/links/globex/sync',
                                     POST | {'client': 'globex-aaaaaaaa-link'}, key=binding['key'])
        self.assertEqual(status, 409, body)
        self.assertEqual(body['error'], 'not_holder')
        status, route = self.stack.api('GET', '/api/v1/links/globex/route', key=binding['key'])
        self.assertEqual(route['sync'], MISSING)

    def test_r2_4_on_disk_before_answer(self) -> None:
        self.holder()
        status, body = self.post()
        self.assertEqual(status, 200, body)
        saved = body['sync']
        self.assertEqual(self.stored(), ('on', 'bbbbbbbb', 1, 1, saved['at']))
        self.stack.restart_relay()
        self.assertEqual(self.route()['sync'], saved)

    def test_r2_4_bad_bodies(self) -> None:
        self.holder()
        cases = [POST | {'state': 'maybe'}, {k: v for k, v in POST.items() if k != 'epoch'},
                 POST | {'copy': None}, POST | {'extra': True}, [], None]
        for field, values in (('client', ['', 'c' * 101, 1, None]),
                              ('generation', [0, -1, True, 1.0, '1', None]),
                              ('epoch', [0, -1, False, 1.0, '1', None]),
                              ('copy', ['', 'c' * 101, 1, []]), ('state', [None, []])):
            cases.extend(POST | {field: value} for value in values)
        for bad in cases:
            with self.subTest(body=bad):
                status, raw = _request(self.stack.relay_port, 'POST', '/api/v1/links/acme/sync',
                                       json.dumps(bad).encode(),
                                       {'Authorization': f'Bearer {self.key}',
                                        'Content-Type': 'application/json'})
                self.assertEqual(status, 400, raw)
                self.assertEqual(json.loads(raw)['error'], 'invalid')
        self.assertIsNone(self.stored())

    def invalid_integers(self, field: str) -> None:
        for value in (9223372036854775808, 10 ** 100, True, False):
            with self.subTest(field=field, value=value):
                try:
                    status, body = self.post(**{field: value})
                except (OSError, http.client.HTTPException):
                    self.fail('The sync API closed the connection instead of returning 400 invalid.')
                self.assertEqual(status, 400, body)
                self.assertEqual(body['error'], 'invalid')
        self.assertEqual(self.route()['sync'], MISSING)
        self.assertIsNone(self.stored())

    def test_r2_4_epoch_integer_range(self) -> None:
        self.holder()
        self.invalid_integers('epoch')
        status, body = self.post(epoch=9223372036854775807)
        self.assertEqual(status, 200, body)
        saved = body['sync']
        self.assertEqual(saved, {'state': 'on', 'copy': 'bbbbbbbb', 'epoch': 9223372036854775807,
                                 'generation': 1, 'at': saved['at']})
        self.assertEqual(self.stored(), ('on', 'bbbbbbbb', 9223372036854775807, 1, saved['at']))
        self.assertEqual(self.route()['sync'], saved)

    def test_r2_4_generation_integer_range(self) -> None:
        self.holder()
        self.invalid_integers('generation')
        status, body = self.post(generation=9223372036854775807)
        self.assertEqual(status, 409, body)
        self.assertEqual(body['error'], 'not_holder')
        self.assertEqual(self.route()['sync'], MISSING)
        self.assertIsNone(self.stored())

    def test_r2_4_unknown_frps(self) -> None:
        tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-sync-nodash-'))
        with Stack(tmp, dashboard=False) as stack:
            binding = stack.bind()
            name = binding['name']
            post = dict(POST, client=f'{name}-aaaaaaaa-link')
            status, body = stack.api('POST', f'/api/v1/links/{name}/sync', post, key=binding['key'])
            self.assertEqual(status, 503, body)
            self.assertEqual(body['error'], 'unknown')
            self.assertIsNone(self.stored(stack))

    def test_r2_4_authentication(self) -> None:
        for key in (None, 'wrong'):
            with self.subTest(key_present=key is not None):
                status, body = self.stack.api('POST', '/api/v1/links/acme/sync', POST, key=key)
                self.assertEqual(status, 401, body)
                self.assertEqual(body['error'], 'unauthorized')
        status, body = self.stack.api('POST', '/api/v1/links/nope/sync', POST, key=self.key)
        self.assertEqual(status, 404, body)
        self.assertEqual(body['error'], 'not_found')
        self.assertIsNone(self.stored())

    def test_r2_4_json_boundary(self) -> None:
        for payload, content_type, want in ((b'{', 'application/json', 400),
                                            (b'{}', 'text/plain', 415),
                                            (b'x' * 4097, 'application/json', 400)):
            with self.subTest(want=want, content_type=content_type):
                status, raw = _request(self.stack.relay_port, 'POST', '/api/v1/links/acme/sync',
                                       payload, {'Authorization': f'Bearer {self.key}',
                                                 'Content-Type': content_type})
                self.assertEqual(status, want, raw)
        self.assertIsNone(self.stored())

    def test_r2_4_simultaneous_epochs(self) -> None:
        self.holder()
        barrier = threading.Barrier(2)

        def post() -> tuple[int, dict | None]:
            barrier.wait(timeout=5)
            return self.post()

        with ThreadPoolExecutor(max_workers=2) as pool:
            answers = list(pool.map(lambda _: post(), range(2)))
        self.assertEqual(sorted(status for status, _ in answers), [200, 409])
        refused = next(body for status, body in answers if status == 409)
        self.assertEqual(refused['error'], 'stale_epoch')
        saved = next(body['sync'] for status, body in answers if status == 200)
        self.assertEqual(self.route()['sync'], saved)

    def test_r2_4_busy_write(self) -> None:
        self.holder()
        with sqlite3.connect(self.stack.env['RELAY_DB'], isolation_level=None) as conn:
            conn.execute('BEGIN IMMEDIATE')
            try:
                connection = http.client.HTTPConnection('127.0.0.1', self.stack.relay_port, timeout=5)
                self.addCleanup(connection.close)
                connection.request('POST', '/api/v1/links/acme/sync', json.dumps(POST),
                                   {'Authorization': f'Bearer {self.key}',
                                    'Content-Type': 'application/json'})
                response = connection.getresponse()
                self.assertEqual(response.status, 503)
                self.assertEqual(response.getheader('Retry-After'), '1')
                self.assertEqual(json.loads(response.read())['error'], 'busy')
            finally:
                conn.execute('ROLLBACK')
        self.assertIsNone(self.stored())


class SyncDiagnosticsTests(unittest.TestCase):
    """Unit tests for sync_answer, set_sync, locked_route_of and frps_route on recorded dashboard samples."""

    def setUp(self) -> None:
        self.tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-sync-unit-'))
        self.relay = load_relay_module()
        self.relay.DB_PATH = f'{self.tmp}/relay.db'
        self.relay._local.__dict__.clear()
        self.relay.init_db()
        self.addCleanup(self.relay.close_db)
        self.lines: list[str] = []
        self.enterContext(patch.object(self.relay, 'log_line', self.lines.append))
        self.enterContext(patch.object(self.relay, 'now', return_value=1_700_000_000))
        self.dash_records: dict[str, tuple[int, dict]] = {}
        self.enterContext(patch.object(self.relay, '_dash_get', self._fake_dash))
        self.key = 'secret-binding-key-never-logged-1234567890'
        self.relay.db().execute(
            'INSERT INTO bindings (name, key_hash, created_at, created_ip) VALUES (?, ?, ?, ?)',
            ('acme', self.relay.key_hash(self.key), 1_700_000_000, 'operator'),
        )
        self.relay.db().commit()
        self.server = self.relay.RelayServer(('127.0.0.1', 0), self.relay.Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self._stop_server)

    def _stop_server(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def _fake_dash(self, path: str, cap: float = 0.5) -> tuple[int, bytes]:
        status, payload = self.dash_records.get(path, (404, {}))
        return status, json.dumps(payload).encode()

    def _call(self, method: str, path: str, body: bytes | dict | None = None,
              key: str | None = 'default', content_type: str = 'application/json',
              visitor_ip: str = '203.0.113.44') -> tuple[int, dict, dict[str, str]]:
        headers = {'X-Forwarded-For': visitor_ip}
        use_key = self.key if key == 'default' else key
        if use_key is not None:
            headers['Authorization'] = f'Bearer {use_key}'
        raw: bytes | None
        if isinstance(body, dict):
            raw = json.dumps(body).encode()
            headers['Content-Type'] = content_type
        elif isinstance(body, bytes):
            raw = body
            headers['Content-Type'] = content_type
        else:
            raw = None
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=2)
        try:
            conn.request(method, path, body=raw, headers=headers)
            res = conn.getresponse()
            data = res.read()
            parsed = json.loads(data) if data else {}
            return res.status, parsed, {k.lower(): v for k, v in res.getheaders()}
        finally:
            conn.close()

    def test_stores_sync_when_prior_proxy_type_remains_offline_in_frps(self) -> None:
        self.relay.db().execute(
            'INSERT INTO routes (name, generation, client, run_id, type, state, since) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ('acme', 2, 'acme-aaaaaaaa-link', 'r2', 'https', 'pending', 1_700_000_000),
        )
        self.relay.db().commit()
        self.dash_records['/api/proxy/http/acme'] = (200, {'status': 'offline', 'clientID': 'acme-00000000-link'})
        self.dash_records['/api/proxy/https/acme'] = (200, {'status': 'online', 'clientID': 'acme-aaaaaaaa-link'})

        status, route, _ = self._call('GET', '/api/v1/links/acme/route')
        self.assertEqual(status, 200, route)
        self.assertEqual((route['state'], route['client'], route['generation']), ('held', 'acme-aaaaaaaa-link', 2))

        post = {'client': 'acme-aaaaaaaa-link', 'generation': 2, 'state': 'on', 'copy': 'bbbbbbbb', 'epoch': 1}
        status, answer, _ = self._call('POST', '/api/v1/links/acme/sync', post)
        self.assertEqual(status, 200, answer)
        self.assertEqual(answer['sync'], {'state': 'on', 'copy': 'bbbbbbbb', 'epoch': 1,
                                          'generation': 2, 'at': 1_700_000_000})

        # Once the https tunnel disconnects as well, both records are offline and the route reads empty, not 503.
        self.dash_records['/api/proxy/https/acme'] = (200, {'status': 'offline', 'clientID': 'acme-aaaaaaaa-link'})
        status, route, _ = self._call('GET', '/api/v1/links/acme/route')
        self.assertEqual(status, 200, route)
        self.assertEqual(route['state'], 'empty')
        self.assertEqual(route['sync'], answer['sync'])

        # Two online routes at once still fail closed as 503 unknown.
        self.dash_records['/api/proxy/http/acme'] = (200, {'status': 'online', 'clientID': 'acme-00000000-link'})
        self.dash_records['/api/proxy/https/acme'] = (200, {'status': 'online', 'clientID': 'acme-aaaaaaaa-link'})
        status, refused, _ = self._call('POST', '/api/v1/links/acme/sync', post | {'epoch': 2})
        self.assertEqual((status, refused['error']), (503, 'unknown'))

    def test_logs_refused_sync_and_unknown_route_without_leaking_keys_or_addresses(self) -> None:
        wrong_key = 'wrong-bearer-secret-token-9876543210'
        visitor_ip = '203.0.113.44'
        body_token = 'caller-supplied-token-value'
        seen_lines: list[str] = []

        def take_lines() -> list[str]:
            batch = list(self.lines)
            seen_lines.extend(batch)
            self.lines.clear()
            return batch

        self.relay.db().execute(
            'INSERT INTO routes (name, generation, client, run_id, type, state, since) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ('acme', 1, 'acme-aaaaaaaa-link', 'r1', 'https', 'held', 1_700_000_000),
        )
        self.relay.db().commit()

        self.dash_records['/api/proxy/https/acme'] = (500, {})
        status, _, _ = self._call('GET', '/api/v1/links/acme/route', visitor_ip=visitor_ip)
        self.assertEqual(status, 503)
        batch = take_lines()
        self.assertTrue(any('route of acme is unknown' in line for line in batch), batch)

        status, _, _ = self._call('POST', '/api/v1/links/acme/sync', POST, visitor_ip=visitor_ip)
        self.assertEqual(status, 503)
        batch = take_lines()
        self.assertTrue(any('sync of acme refused: unknown' in line for line in batch), batch)

        self.dash_records['/api/proxy/https/acme'] = (200, {'status': 'online', 'clientID': 'acme-aaaaaaaa-link'})
        status, _, _ = self._call('POST', '/api/v1/links/acme/sync',
                                  POST | {'client': body_token, 'copy': body_token}, visitor_ip=visitor_ip)
        self.assertEqual(status, 409)
        batch = take_lines()
        self.assertTrue(any('sync of acme refused: not_holder' in line for line in batch), batch)

        status, _, _ = self._call('POST', '/api/v1/links/acme/sync', POST, visitor_ip=visitor_ip)
        self.assertEqual(status, 200)
        take_lines()
        status, _, _ = self._call('POST', '/api/v1/links/acme/sync', POST, visitor_ip=visitor_ip)
        self.assertEqual(status, 409)
        batch = take_lines()
        self.assertTrue(any('sync of acme refused: stale_epoch' in line for line in batch), batch)

        status, _, _ = self._call('POST', '/api/v1/links/acme/sync', b'{bad', visitor_ip=visitor_ip)
        self.assertEqual(status, 400)
        batch = take_lines()
        self.assertTrue(any('sync of acme refused: invalid' in line for line in batch), batch)

        status, _, _ = self._call('POST', '/api/v1/links/acme/sync', b'{}',
                                  content_type='text/plain', visitor_ip=visitor_ip)
        self.assertEqual(status, 415)
        batch = take_lines()
        self.assertTrue(any('sync of acme refused: unsupported_media_type' in line for line in batch), batch)

        status, _, _ = self._call('POST', '/api/v1/links/acme/sync', POST, key=wrong_key, visitor_ip=visitor_ip)
        self.assertEqual(status, 401)
        batch = take_lines()
        self.assertTrue(any('sync of acme refused: unauthorized' in line for line in batch), batch)

        with patch.object(self.relay, 'set_sync', side_effect=self.relay.WriteBusy('locked')):
            status, body, headers = self._call('POST', '/api/v1/links/acme/sync', POST | {'epoch': 2},
                                               visitor_ip=visitor_ip)
        self.assertEqual((status, body['error'], headers.get('retry-after')), (503, 'busy', '1'))
        batch = take_lines()
        self.assertTrue(any('sync of acme refused: busy' in line for line in batch), batch)

        joined = '\n'.join(seen_lines)
        for secret in (self.key, wrong_key, visitor_ip, '127.0.0.1', body_token):
            self.assertNotIn(secret, joined)


if __name__ == '__main__':
    unittest.main()
