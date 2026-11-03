"""Only a live route's holder may persist a newer sync record: R2.4."""

from concurrent.futures import ThreadPoolExecutor
import http.client
import json
import sqlite3
import tempfile
import threading
import time
import unittest

if __package__:
    from .harness import Client, Stack, _request, _wait
else:
    from harness import Client, Stack, _request, _wait


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
            binding = stack.bind('acme')
            status, body = stack.api('POST', '/api/v1/links/acme/sync', POST, key=binding['key'])
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


if __name__ == '__main__':
    unittest.main()
