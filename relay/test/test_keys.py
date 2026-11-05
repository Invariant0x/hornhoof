"""Link key rotation, bans and freed-name availability: R6.1 and R1.5."""

import base64
import http.client
import importlib.util
import json
from pathlib import Path
import re
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from collections.abc import Callable
from contextlib import redirect_stderr, redirect_stdout
from http.server import ThreadingHTTPServer
from io import StringIO
from typing import NamedTuple
from unittest.mock import patch

if __package__:
    from .harness import ROOT, Client, Stack, _request, _wait, load_relay_module
else:
    from harness import ROOT, Client, Stack, _request, _wait, load_relay_module


KEY_PATH = '/api/v1/links/acme/key'
VISITOR_KEY_PATH = '/api/v1/links/acme/visitor-key'
ROUTE_PATH = '/api/v1/links/acme/route'
SYNC_PATH = '/api/v1/links/acme/sync'
# Fixed, so that nothing in the in-process tests rests on randomness. No relay outside these tests knows it.
CHOSEN_KEY = 'a' * 43


class KeyTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-keys-'))
        self.stack = self.enterContext(Stack(tmp))
        self.key = self.stack.bind('acme')['key']

    def rotate(self, key: str) -> str:
        status, body = self.stack.api('POST', KEY_PATH, key=key)
        self.assertEqual(status, 200, 'key rotation must succeed')
        self.assertTrue(isinstance(body, dict) and set(body) == {'key'},
                        'rotation must return only the key')
        new = body['key']
        self.assertTrue(isinstance(new, str) and re.fullmatch(r'[A-Za-z0-9_-]{43}', new) is not None,
                        'rotation must return a base64url key')
        self.assertTrue(len(base64.urlsafe_b64decode(new + '=')) == 32,
                        'the decoded key must have 32 bytes')
        self.assertTrue(new != key, 'rotation must replace the key')
        self.stack.private.append(new)
        return new

    def route(self, key: str) -> dict:
        status, body = self.stack.api('GET', ROUTE_PATH, key=key)
        self.assertEqual(status, 200, 'the current key must read the route')
        return body

    def route_a_key_change_must_keep(self, key: str) -> dict:
        """All of the route but relayStarted, which moves when the watcher sees frps come back, whatever the key."""
        return {field: value for field, value in self.route(key).items() if field != 'relayStarted'}

    def holder(self, settings: str = 'network') -> Client:
        client_id = 'acme-aaaaaaaa-link' if settings == 'network' else None
        client = self.stack.client('acme', self.key, settings=settings, client=client_id)
        self.assertTrue(client.started('acme'), client.log())
        self.assertEqual(self.route(self.key)['state'], 'held')
        return client

    def admin(self, *args: str) -> str:
        result = subprocess.run([sys.executable, str(ROOT / 'relay/relay.py'), 'admin', *args],
                                env=self.stack.env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, 'the local admin command must succeed')
        return result.stdout

    def test_r6_1_change_key(self) -> None:
        first = self.holder()
        original = self.route_a_key_change_must_keep(self.key)
        new = self.rotate(self.key)
        self.assertEqual(self.stack.api('GET', ROUTE_PATH, key=self.key)[0], 401)
        self.assertEqual(self.route_a_key_change_must_keep(new), original)
        self.assertEqual(self.stack.get('acme.hornhoof.org'), 200)
        refused = self.stack.client('acme', self.key, settings='network', client='acme-bbbbbbbb-link')
        self.assertTrue(_wait(lambda: 'no binding acme with this key' in refused.log(), 5), refused.log())
        self.assertFalse(refused.started('acme', within=0.1), refused.log())
        refused.stop()
        waiting = self.stack.client('acme', new, settings='network', client='acme-bbbbbbbb-link')
        self.assertTrue(_wait(lambda: 'router config conflict' in waiting.log(), 5), waiting.log())
        self.assertFalse(waiting.started('acme', within=0.1), waiting.log())
        waiting.stop()
        first.stop()
        self.assertTrue(_wait(lambda: self.route(new)['state'] == 'empty', 5))
        replacement = self.stack.client('acme', new, settings='network', client='acme-bbbbbbbb-link')
        self.assertTrue(replacement.started('acme'), replacement.log())
        self.assertEqual(self.route(new)['client'], 'acme-bbbbbbbb-link')
        self.assertEqual(self.stack.get('acme.hornhoof.org'), 200)

    def test_r6_1_old_key_refused_by_every_public_endpoint(self) -> None:
        new = self.rotate(self.key)
        for method, path, body in (
                ('GET', ROUTE_PATH, None), ('POST', KEY_PATH, None),
                ('POST', '/api/v1/links/acme/visitor-key', None),
                ('POST', '/api/v1/links/acme/sync', {}),
                ('DELETE', '/api/v1/bindings/acme', None)):
            with self.subTest(method=method, path=path):
                status, answer = self.stack.api(method, path, body, key=self.key)
                self.assertEqual(status, 401, 'the old key must refuse before doing any work')
                self.assertTrue(answer.get('error') == 'unauthorized', 'wrong-key refusal expected')
        self.assertEqual(self.route(new)['state'], 'empty')
        status, body = self.stack.api('POST', '/api/v1/links/acme/visitor-key', key=new)
        self.assertEqual(status, 200, 'the new key must authorize visitor-key issuance')
        visitor = body['visitorKey']
        outputs = [self.stack.relay.log_path.read_text(), self.admin('list'), self.admin('banned-caddy')]
        self.assertTrue(all(new not in text and visitor not in text for text in outputs),
                        'generated credentials must not reach logs or admin output')

    def test_r6_1_legacy_survives_rotation_and_relay_restart_through_ping(self) -> None:
        self.holder('today')
        original = self.route(self.key)
        new = self.rotate(self.key)
        current = self.rotate(new)
        self.stack.restart_relay()
        deadline = time.monotonic() + 35
        while not any(call['op'] == 'Ping' for call in self.stack.plugin_calls()):
            self.assertEqual(self.stack.get('acme.hornhoof.org'), 200)
            self.assertLess(time.monotonic(), deadline, 'the original legacy heartbeat must arrive')
            time.sleep(0.25)
        pings = [call for call in self.stack.plugin_calls() if call['op'] == 'Ping']
        self.assertTrue(all(not call['reject'] for call in pings), 'rotation must preserve legacy heartbeats')
        self.assertEqual(self.stack.get('acme.hornhoof.org'), 200)
        after = self.route(current)
        self.assertEqual((after['state'], after['generation'], after['since']),
                         ('held', original['generation'], original['since']))

    def chosen_key(self) -> str:
        """32 random bytes in base64url, which no log this test prints may show."""
        chosen = secrets.token_urlsafe(32)
        self.stack.private.append(chosen)
        return chosen

    def test_r6_1_chosen_key(self) -> None:
        self.holder()
        chosen = self.chosen_key()
        status, body = self.stack.api('POST', KEY_PATH, {'key': chosen}, key=self.key)
        self.assertEqual(status, 200, 'a well-formed chosen key must be taken')
        self.assertTrue(body == {'key': chosen}, 'the answer must be the chosen key and nothing else')
        self.assertEqual(self.route(chosen)['state'], 'held', 'the live tunnel must keep its route')
        self.assertEqual(self.stack.get('acme.hornhoof.org'), 200)
        self.assertEqual(self.stack.api('GET', ROUTE_PATH, key=self.key)[0], 401)
        refused = self.stack.client('acme', self.key, settings='network', client='acme-bbbbbbbb-link')
        self.assertTrue(_wait(lambda: 'no binding acme with this key' in refused.log(), 5), refused.log())
        self.assertFalse(refused.started('acme', within=0.1), refused.log())
        self.assertTrue(chosen not in self.stack.relay.log_path.read_text(), 'a chosen key must not reach the log')

    def test_r6_1_chosen_key_refused(self) -> None:
        chosen = self.chosen_key()
        for label, body, code in (('42 characters', {'key': chosen[:42]}, 'invalid'),
                                  ('43 with a plus', {'key': chosen[:42] + '+'}, 'invalid'),
                                  ('another field', {'key': chosen, 'extra': 1}, 'invalid'),
                                  ('the current key', {'key': self.key}, 'same_key')):
            with self.subTest(label):
                status, answer = self.stack.api('POST', KEY_PATH, body, key=self.key)
                self.assertEqual(status, 400, 'this body must be refused')
                self.assertTrue(answer.get('error') == code, f'the refusal must say {code}')
                self.assertTrue(body['key'] not in json.dumps(answer), 'a refusal must not repeat the key it was sent')
                self.route(self.key)
        status, _ = self.stack.api('POST', KEY_PATH, {'key': chosen}, key='wrong')
        self.assertEqual(status, 401, 'a chosen key goes nowhere without the current key')
        self.route(self.key)
        self.assertEqual(self.stack.api('GET', ROUTE_PATH, key=chosen)[0], 401, 'no refusal may change the key')

    def test_r6_1_random_key_stays(self) -> None:
        new = self.rotate(self.key)
        self.assertEqual(self.stack.api('GET', ROUTE_PATH, key=self.key)[0], 401)
        self.route(new)
        status, body = self.stack.api('POST', KEY_PATH, {}, key=new)
        self.assertEqual(status, 200, 'an empty object asks for a new random key too')
        self.stack.private.append(body['key'])
        self.assertTrue(body['key'] != new, 'the key must change')
        self.route(body['key'])

    def test_ban_without_a_restart(self) -> None:
        client = self.holder()
        started = Path(self.stack.env['RELAY_FRPS_STARTED']).read_bytes()
        pid = self.stack.frps.process.pid
        self.admin('ban', 'acme')
        self.assertIn('acme.hornhoof.org', self.admin('banned-caddy'))
        client.kill()
        retry = self.stack.client('acme', self.key, settings='network', client='acme-aaaaaaaa-link')
        self.assertTrue(_wait(lambda: 'acme.hornhoof.org is blocked' in retry.log(), 5), retry.log())
        self.assertFalse(retry.started('acme', within=0.1), retry.log())
        self.assertEqual(Path(self.stack.env['RELAY_FRPS_STARTED']).read_bytes(), started)
        self.assertEqual(self.stack.frps.process.pid, pid)
        self.assertIsNone(self.stack.frps.process.poll())

    def test_caddy_blocks_before_frps(self) -> None:
        wildcard = (ROOT / 'Caddyfile').read_text().split('*.hornhoof.org {', 1)[1]
        self.assertLess(wildcard.index('import blocked.caddy'),
                        wildcard.index('reverse_proxy 127.0.0.1:8080'))

    def test_ban_today_client_cut_by_ping(self) -> None:
        self.holder('today')
        pid = self.stack.frps.process.pid
        started = Path(self.stack.env['RELAY_FRPS_STARTED']).read_bytes()
        self.admin('ban', 'acme')
        self.assertTrue(_wait(lambda: self.route(self.key)['state'] == 'empty', 40),
                        'a blocked legacy tunnel must go at its next heartbeat')
        self.assertTrue(any(call['op'] == 'Ping' and call['reject']
                            for call in self.stack.plugin_calls()), 'the ban must refuse Ping')
        self.assertEqual(self.stack.frps.process.pid, pid)
        self.assertEqual(Path(self.stack.env['RELAY_FRPS_STARTED']).read_bytes(), started)

    def test_r1_5_freed_name_waits_for_its_tunnel(self) -> None:
        client = self.holder()
        self.assertEqual(self.stack.api('DELETE', '/api/v1/bindings/acme', key=self.key)[0], 204)
        self.assertEqual(self.stack.get('acme.hornhoof.org'), 200)
        status, body = self.stack.api('GET', '/api/v1/names/acme')
        self.assertEqual((status, body), (200, {'name': 'acme', 'free': False, 'reason': 'taken'}))
        status, body = self.stack.api('POST', '/api/v1/bindings', {'name': 'acme'})
        self.assertEqual(status, 409, 'a freed live route must prevent rebinding')
        self.assertTrue(body.get('error') == 'taken', 'a freed live route is taken')
        client.stop()
        self.assertTrue(_wait(lambda: self.stack.dash('/api/proxy/http/acme')[1]['status'] == 'offline', 5))
        self.assertEqual(self.stack.api('GET', '/api/v1/names/acme'), (200, {'name': 'acme', 'free': True}))
        status, _body = self.stack.api('POST', '/api/v1/bindings', {'name': 'acme'})
        self.assertEqual(status, 201, 'an offline freed name must bind again')

    def test_r1_5_an_operators_add_waits_for_the_tunnel_too(self) -> None:
        # An http-mode tunnel gets no NewUserConn, so that a name bound again while it lives sends its visitors to the old owner.
        client = self.holder('today')
        self.assertEqual(self.stack.api('DELETE', '/api/v1/bindings/acme', key=self.key)[0], 204)
        refused = subprocess.run([sys.executable, str(ROOT / 'relay/relay.py'), 'admin', 'add', 'acme'],
                                 env=self.stack.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(refused.returncode, 1, 'a live route must keep the name from a new owner')
        self.assertIn('acme: taken', refused.stderr)
        self.assertTrue(refused.stdout == '', 'a refused name must hand out no key')
        client.stop()
        self.assertTrue(_wait(lambda: self.stack.dash('/api/proxy/http/acme')[1]['status'] == 'offline', 5))
        added = json.loads(self.admin('add', 'acme'))
        self.stack.private.append(added['key'])
        self.assertEqual(added['name'], 'acme')

    def test_r2_4_a_freed_names_sync_record_goes_with_it(self) -> None:
        first = self.holder()
        post = {'client': 'acme-aaaaaaaa-link', 'generation': self.route(self.key)['generation'],
                'state': 'on', 'copy': 'bbbbbbbb', 'epoch': 900}
        self.assertEqual(self.stack.api('POST', SYNC_PATH, post, key=self.key)[0], 200)
        first.stop()
        self.assertTrue(_wait(lambda: self.route(self.key)['state'] == 'empty', 5))
        self.assertEqual(self.stack.api('DELETE', '/api/v1/bindings/acme', key=self.key)[0], 204)
        new = self.stack.bind('acme')['key']
        self.assertEqual(self.route(new)['sync'],
                         {'state': 'off', 'copy': None, 'epoch': 0, 'generation': 0, 'at': None})
        second = self.stack.client('acme', new, settings='network', client='acme-cccccccc-link')
        self.assertTrue(second.started('acme'), second.log())
        generation = self.route(new)['generation']
        self.assertGreater(generation, post['generation'], 'the generation only grows across owners')
        status, body = self.stack.api('POST', SYNC_PATH, dict(post, client='acme-cccccccc-link', generation=generation,
                                                              copy='cccccccc', epoch=1), key=new)
        self.assertEqual(status, 200, 'the next owner starts from epoch 0')
        self.assertEqual(body['sync']['copy'], 'cccccccc')

    def test_r1_5_cannot_tell(self) -> None:
        tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-keys-nodash-'))
        with Stack(tmp, dashboard=False) as stack:
            for method, path, data in (('GET', '/api/v1/names/globex', None),
                                        ('POST', '/api/v1/bindings', {'name': 'globex'})):
                with self.subTest(method=method):
                    status, body = stack.api(method, path, data)
                    self.assertEqual(status, 503, 'an unknown route must prevent a named binding')
                    self.assertTrue(body.get('error') == 'unknown', 'the route is unknown')
            status, body = stack.api('POST', '/api/v1/bindings', {})
            self.assertEqual(status, 201, 'a random binding must bypass the dashboard')
            self.assertTrue(re.fullmatch(r'[a-z0-9]{24}', body['name']) is not None,
                            'a random binding must have a fresh random name')


class ChosenKeyRuleTests(unittest.TestCase):
    """R6.1: what the body of a key change asks for, by the rule alone, with nothing running."""

    CURRENT = 'c' * 43

    @classmethod
    def setUpClass(cls) -> None:
        cls.relay = load_relay_module()

    def refusal_of(self, body: object) -> str:
        with self.assertRaises(self.relay.KeyRefused) as refused:
            self.relay.new_link_key(body, self.CURRENT)
        return refused.exception.code

    def test_a_body_that_chooses_nothing_gets_a_new_random_key(self) -> None:
        first, second = (self.relay.new_link_key({}, self.CURRENT) for _ in range(2))
        self.assertTrue(re.fullmatch(r'[A-Za-z0-9_-]{43}', first) is not None, 'a new key has the one form')
        self.assertTrue(first != second, 'and is new each time')

    def test_a_key_of_the_right_form_is_the_key_asked_for(self) -> None:
        for chosen in (CHOSEN_KEY, 'aZ09_-' + 'x' * 37):
            with self.subTest(chosen=chosen):
                self.assertEqual(self.relay.new_link_key({'key': chosen}, self.CURRENT), chosen)

    def test_any_other_body_is_invalid(self) -> None:
        for body in (None, [], [CHOSEN_KEY], CHOSEN_KEY, 5, True,
                     {'key': None}, {'key': 5}, {'key': [CHOSEN_KEY]}, {'key': ''},
                     {'key': 'a' * 42}, {'key': 'a' * 44}, {'key': 'a' * 42 + '+'}, {'key': 'a' * 42 + '='},
                     {'key': CHOSEN_KEY + '\n'}, {'key': '\u0663' * 43}, {'key': 'a' * 42 + '\ud800'},
                     {'key': CHOSEN_KEY, 'extra': 1}, {'extra': 1}, {'Key': CHOSEN_KEY}):
            with self.subTest(body=ascii(body)):
                self.assertEqual(self.refusal_of(body), 'invalid')

    def test_the_current_key_cannot_be_chosen(self) -> None:
        self.assertEqual(self.refusal_of({'key': self.CURRENT}), 'same_key')


class RelayInProcess(unittest.TestCase):
    """HTTP against an isolated relay with real SQLite writes; `acme` is bound with the key `old`."""

    def setUp(self) -> None:
        tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-key-auth-'))
        spec = importlib.util.spec_from_file_location('relay_keys_under_test', ROOT / 'relay/relay.py')
        self.relay = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.relay)
        self.relay.DB_PATH = str(Path(tmp) / 'relay.db')
        self.relay.CADDYFILE = str(ROOT / 'Caddyfile')
        self.relay.init_db()
        self.addCleanup(self.relay.db().close)
        self.bind('old')
        relay = self.relay

        class ClosingHandler(relay.Handler):
            def finish(self) -> None:
                try:
                    super().finish()
                finally:
                    conn = getattr(relay._local, 'conn', None)
                    if conn is not None:
                        conn.close()
                        relay._local.conn = None

        server = ThreadingHTTPServer(('127.0.0.1', 0), ClosingHandler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.port = server.server_port

    def bind(self, key: str) -> None:
        self.relay.write('INSERT INTO bindings (name, key_hash, created_at) VALUES (?, ?, ?)',
                         ('acme', self.relay.key_hash(key), self.relay.now()))

    def api(self, method: str, path: str, key: str | None = None,
            body: dict | None = None, ip: str = '127.0.0.1') -> tuple[int, dict | None]:
        headers = {'X-Forwarded-For': ip, 'Content-Type': 'application/json'}
        if key is not None:
            headers['Authorization'] = f'Bearer {key}'
        status, raw = _request(self.port, method, path, json.dumps(body) if body is not None else None, headers)
        return status, json.loads(raw) if raw else None

    def counts(self) -> tuple[int, int]:
        """How many bindings and creations are stored; a refusal must add to neither."""
        conn = self.relay.db()
        return (conn.execute('SELECT COUNT(*) FROM bindings').fetchone()[0],
                conn.execute('SELECT COUNT(*) FROM creations').fetchone()[0])

    def current_hash_matches(self, key: str) -> bool:
        row = self.relay.db().execute("SELECT key_hash FROM bindings WHERE name = 'acme'").fetchone()
        return row is not None and row[0] == self.relay.key_hash(key)

    def lifetime_rows(self) -> dict[str, int]:
        return {table: self.relay.db().execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
                for table in ('visitor_keys', 'ping_keys', 'sync')}


class KeyAuthorizationTests(RelayInProcess):
    """Who may change a key, and what a change leaves behind, against real SQLite writes."""

    def paused_rotation(self, change_owner: Callable[[], None]) -> None:
        """Pause after successful authorization, then change the binding before the write."""
        entered, resume = threading.Event(), threading.Event()
        original = self.relay.Handler.authorize_link

        def authorize(handler, name: str) -> bool:
            allowed = original(handler, name)
            if allowed:
                entered.set()
                if not resume.wait(5):
                    raise TimeoutError('key authorization was not resumed')
            return allowed

        results = []
        with patch.object(self.relay.Handler, 'authorize_link', authorize):
            worker = threading.Thread(target=lambda: results.append(self.api('POST', KEY_PATH, 'old')))
            worker.start()
            try:
                self.assertTrue(entered.wait(3), 'the rotation must reach successful authorization')
                change_owner()
            finally:
                resume.set()
                worker.join(5)
            self.assertFalse(worker.is_alive(), 'the rotation must finish')
        self.assertEqual(results[0][0], 404, 'a stale authorization must refuse the key update')

    def test_r6_1_authorized_before_release_cannot_overwrite_next_owner(self) -> None:
        def rebind() -> None:
            self.relay.release_binding('acme')
            self.bind('next-owner')

        try:
            self.paused_rotation(rebind)
        finally:
            self.assertTrue(self.current_hash_matches('next-owner'),
                            'a stale rotation must preserve the next owner key')

    def test_r6_1_authorized_before_ban_cannot_replace_key(self) -> None:
        def ban() -> None:
            self.relay.write('UPDATE bindings SET banned_at = ? WHERE name = ?', (self.relay.now(), 'acme'))

        try:
            self.paused_rotation(ban)
        finally:
            self.assertTrue(self.current_hash_matches('old'), 'a ban must prevent an in-flight rotation')

    def test_r6_1_authentication_and_wrong_key_limit(self) -> None:
        self.assertEqual(self.api('POST', '/api/v1/links/nope/key', 'old')[0], 404)
        for attempt in range(30):
            with self.subTest(attempt=attempt):
                key = None if attempt == 0 else 'wrong'
                status, body = self.api('POST', KEY_PATH, key)
                self.assertEqual(status, 401)
                self.assertTrue(body.get('error') == 'unauthorized', 'wrong-key refusal expected')
        status, body = self.api('POST', KEY_PATH, 'wrong')
        self.assertEqual(status, 429)
        self.assertTrue(body.get('error') == 'rate_limited', 'bad keys must share the existing limit')
        status, body = self.api('POST', KEY_PATH, 'old')
        self.assertEqual(status, 200, 'valid credentials must still work after wrong-key throttling')
        self.assertTrue(self.current_hash_matches(body['key']), 'rotation must store the issued key hash')

    def test_r6_1_busy_write_preserves_authorizing_key(self) -> None:
        conn = sqlite3.connect(self.relay.DB_PATH, isolation_level=None)
        self.addCleanup(conn.close)
        conn.execute('BEGIN IMMEDIATE')
        try:
            connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
            self.addCleanup(connection.close)
            connection.request('POST', KEY_PATH, headers={'Authorization': 'Bearer old'})
            response = connection.getresponse()
            self.assertEqual(response.status, 503)
            self.assertEqual(response.getheader('Retry-After'), '1')
            self.assertTrue(json.loads(response.read()).get('error') == 'busy', 'busy refusal expected')
        finally:
            conn.execute('ROLLBACK')
        self.assertTrue(self.current_hash_matches('old'), 'a busy update must leave the original key intact')

    def rotated_key(self, key: str) -> str:
        status, body = self.api('POST', KEY_PATH, key)
        self.assertEqual(status, 200, 'key rotation must succeed')
        return body['key']

    def ping(self, key: object) -> dict:
        return self.relay.plugin('Ping', {'user': {'run_id': 'legacy-session',
                                                 'metas': {'name': 'acme', 'key': key}}})

    def test_r6_1_retired_ping_cannot_bypass_ban_release_or_rebind(self) -> None:
        new = self.rotated_key('old')
        self.rotated_key(new)
        self.assertFalse(self.ping('old')['reject'])
        self.assertFalse(self.ping(new)['reject'])
        for invalid in (None, '', [], 'wrong', 5, ['wrong']):
            with self.subTest(invalid_type=type(invalid).__name__):
                self.assertTrue(self.ping(invalid)['reject'])
        for op, content in (('Login', {'metas': {'name': 'acme', 'key': 'old'}}),
                            ('NewProxy', {'user': {'metas': {'name': 'acme', 'key': 'old'}}})):
            self.assertTrue(self.relay.plugin(op, content)['reject'], 'a retired key must not log in or register')
        self.relay.write("UPDATE bindings SET banned_at = 1 WHERE name = 'acme'", ())
        self.assertTrue(self.ping('old')['reject'], 'a ban must refuse retired heartbeats')
        self.relay.unban_binding('acme')
        self.assertFalse(self.ping('old')['reject'])
        self.relay.release_binding('acme')
        self.assertTrue(self.ping('old')['reject'], 'a release must refuse retired heartbeats')
        self.bind('next-owner')
        self.assertTrue(self.ping('old')['reject'], 'a rebind must refuse the previous lifetime heartbeat')
        self.rotated_key('next-owner')
        self.assertTrue(self.ping('old')['reject'], 'a new lifetime rotation must not revive prior hashes')

    def choose(self, current: str, chosen: str) -> None:
        status, _ = self.api('POST', KEY_PATH, current, body={'key': chosen})
        self.assertEqual(status, 200, 'a well-formed chosen key must be taken')

    def test_r6_1_a_chosen_key_retires_the_old_one_as_a_random_key_does(self) -> None:
        self.choose('old', CHOSEN_KEY)
        self.assertTrue(self.current_hash_matches(CHOSEN_KEY), 'the chosen key must be the key')
        self.assertEqual(self.api('GET', ROUTE_PATH, 'old')[0], 401)
        self.assertFalse(self.ping('old')['reject'], 'a tunnel of the old key keeps its heartbeat')
        self.assertIsNone(self.relay.link_refusal('acme', 'old'), 'and takes new connections')
        login = self.relay.plugin('Login', {'metas': {'name': 'acme', 'key': 'old'}})
        self.assertTrue(login['reject'], 'the old key must not log in again')
        self.relay.release_binding('acme')
        self.assertEqual(self.lifetime_rows()['ping_keys'], 0, 'a release takes the retired key with it')

    def test_r6_1_a_retired_key_chosen_again_leaves_every_tunnel_its_heartbeat(self) -> None:
        # A random key never returns, so only a chosen key can make a retired hash the current one.
        again = 'b' * 43
        self.choose('old', CHOSEN_KEY)
        self.choose(CHOSEN_KEY, again)
        self.choose(again, CHOSEN_KEY)
        self.assertTrue(self.current_hash_matches(CHOSEN_KEY), 'the key chosen again must be the key')
        self.assertEqual(self.api('GET', ROUTE_PATH, again)[0], 401)
        self.rotated_key(CHOSEN_KEY)
        self.assertEqual(self.api('GET', ROUTE_PATH, CHOSEN_KEY)[0], 401)
        for retired in ('old', CHOSEN_KEY, again):
            with self.subTest(retired=retired):
                self.assertFalse(self.ping(retired)['reject'], 'each earlier tunnel keeps its heartbeat')

    def test_r6_2_a_visitor_key_is_never_chosen(self) -> None:
        for body in ({'key': CHOSEN_KEY}, {'key': 'short', 'extra': 1}):
            with self.subTest(body=body):
                status, answer = self.api('POST', VISITOR_KEY_PATH, 'old', body=body)
                self.assertEqual(status, 200, 'a visitor key post ignores its body')
                self.assertTrue(answer['visitorKey'] != CHOSEN_KEY, 'a visitor key is the relay\'s own')
                self.assertTrue(self.current_hash_matches('old'), 'the link key must stay')

    def test_r6_1_rotation_rolls_back_if_heartbeat_retention_fails(self) -> None:
        original = self.relay.write

        def fail_retention(sql: str, args: tuple) -> None:
            if sql.startswith('INSERT INTO ping_keys'):
                raise self.relay.WriteBusy('test contention')
            original(sql, args)

        with patch.object(self.relay, 'write', fail_retention):
            status, body = self.api('POST', KEY_PATH, 'old')
        self.assertEqual(status, 503, 'a failed rotation must refuse without issuing a key')
        self.assertTrue(body.get('error') == 'busy', 'busy refusal expected')
        self.assertTrue(self.current_hash_matches('old'), 'a failed rotation must roll back its key update')
        self.assertFalse(self.relay.db().in_transaction, 'a failed rotation must end its transaction')
        self.rotated_key('old')

    def test_r1_5_local_name_restrictions_precede_unknown_dashboard(self) -> None:
        with patch.object(self.relay, '_dash_get', side_effect=self.relay.FrpsUnknown('test unavailable')):
            for name, reason, bind_status in (('bad_name', 'invalid', 400),
                                               ('www', 'reserved', 409), ('acme', 'taken', 409)):
                with self.subTest(name=name):
                    self.assertEqual(self.api('GET', f'/api/v1/names/{name}'),
                                     (200, {'name': name, 'free': False, 'reason': reason}))
                    status, body = self.api('POST', '/api/v1/bindings', body={'name': name})
                    self.assertEqual(status, bind_status)
                    self.assertTrue(body.get('error') == reason, 'local name restriction must win')
            for method, path, body in (('GET', '/api/v1/names/globex', None),
                                        ('POST', '/api/v1/bindings', {'name': 'globex'})):
                status, answer = self.api(method, path, body=body)
                self.assertEqual(status, 503)
                self.assertTrue(answer.get('error') == 'unknown', 'an unavailable dashboard must refuse')
            self.assertEqual(self.api('POST', '/api/v1/bindings', body={})[0], 201)

    def test_r1_5_https_route_is_taken_and_ambiguous_routes_are_unknown(self) -> None:
        def dashboard(path: str, cap: float = 0.5) -> tuple[int, bytes]:
            if '/https/' in path:
                return 200, b'{"status":"online","clientID":"globex-aaaaaaaa-link"}'
            return 404, b'{}'

        with patch.object(self.relay, '_dash_get', dashboard):
            self.assertEqual(self.api('GET', '/api/v1/names/globex'),
                             (200, {'name': 'globex', 'free': False, 'reason': 'taken'}))
            status, body = self.api('POST', '/api/v1/bindings', body={'name': 'globex'})
            self.assertEqual(status, 409)
            self.assertTrue(body.get('error') == 'taken', 'an HTTPS route must reserve the name')
        for payload in (b'{}', b'{', b'{"status":"online","clientID":"c"}'):
            with self.subTest(payload=payload):
                with patch.object(self.relay, '_dash_get', return_value=(200, payload)):
                    self.assertEqual(self.api('GET', '/api/v1/names/globex')[0], 503)
                    self.assertEqual(self.api('POST', '/api/v1/bindings', body={'name': 'globex'})[0], 503)

    def test_r1_5_availability_and_binding_rate_limits_still_apply(self) -> None:
        with patch.object(self.relay, '_dash_get', side_effect=self.relay.FrpsUnknown('test unavailable')):
            for _ in range(60):
                self.assertEqual(self.api('GET', '/api/v1/names/globex')[0], 503)
            self.assertEqual(self.api('GET', '/api/v1/names/globex')[0], 429)
            for _ in range(5):
                self.assertEqual(self.api('POST', '/api/v1/bindings', body={})[0], 201)
            self.assertEqual(self.api('POST', '/api/v1/bindings', body={})[0], 429)

    def give_the_binding_a_lifetime(self) -> str:
        """Two rotations, a visitor key and a sync record; answers the binding's current key."""
        current = self.rotated_key(self.rotated_key('old'))
        self.assertEqual(self.api('POST', '/api/v1/links/acme/visitor-key', current)[0], 200)
        self.relay.write('INSERT INTO sync (name, state, copy, epoch, generation, at) VALUES (?, ?, ?, ?, ?, ?)',
                         ('acme', 'on', 'bbbbbbbb', 900, 1, 1))
        self.assertEqual(self.lifetime_rows(), {'visitor_keys': 1, 'ping_keys': 2, 'sync': 1})
        return current

    def test_release_takes_what_belongs_to_the_binding(self) -> None:
        current = self.give_the_binding_a_lifetime()
        self.assertEqual(self.api('DELETE', '/api/v1/bindings/acme', current)[0], 204)
        self.assertEqual(self.lifetime_rows(), {'visitor_keys': 0, 'ping_keys': 0, 'sync': 0})

    def test_admin_release_takes_what_belongs_to_the_binding(self) -> None:
        self.give_the_binding_a_lifetime()
        self.relay.release_binding('acme')
        self.assertEqual(self.lifetime_rows(), {'visitor_keys': 0, 'ping_keys': 0, 'sync': 0})

    def test_refused_release_leaves_what_belongs_to_the_binding(self) -> None:
        current = self.give_the_binding_a_lifetime()
        kept = {'visitor_keys': 1, 'ping_keys': 2, 'sync': 1}
        self.assertFalse(self.relay.release_binding('acme', self.relay.key_hash('old')), 'a stale hash is refused')
        self.assertEqual(self.lifetime_rows(), kept)
        self.relay.write("UPDATE bindings SET banned_at = 1 WHERE name = 'acme'", ())
        self.assertFalse(self.relay.release_binding('acme', self.relay.key_hash(current)), 'a ban is not erased')
        self.assertEqual(self.lifetime_rows(), kept)

    def test_r2_4_a_sync_post_authorized_before_a_release_cannot_reach_the_next_owner(self) -> None:
        """The post passes its checks for the old owner, then the name changes hands before its write."""
        self.relay.write('INSERT INTO routes (name, generation, client, run_id, type, state, since) '
                         "VALUES ('acme', 1, 'acme-aaaaaaaa-link', 'run', 'http', 'held', 1)", ())
        online = b'{"status":"online","clientID":"acme-aaaaaaaa-link"}'
        real_holder_check = self.relay.sync_holder

        def holder_then_new_owner(name: str, body: dict) -> bool:
            held = real_holder_check(name, body)
            self.relay.release_binding('acme')
            self.bind('next-owner')
            return held

        post = {'client': 'acme-aaaaaaaa-link', 'generation': 1, 'state': 'on', 'copy': 'bbbbbbbb', 'epoch': 900}
        def dashboard(path: str, cap: float = 0.5) -> tuple[int, bytes]:
            return (200, online) if '/http/' in path else (404, b'{}')

        with (patch.object(self.relay, '_dash_get', dashboard),
              patch.object(self.relay, 'sync_holder', holder_then_new_owner)):
            status, body = self.api('POST', SYNC_PATH, 'old', post)
        self.assertEqual(status, 409, 'a post authorized for the old owner must not be stored')
        self.assertEqual(body, {'error': 'not_holder'})
        self.assertEqual(self.lifetime_rows()['sync'], 0, 'the next owner must not inherit the post')

    def test_r6_1_key_is_answered_only_on_its_own_path(self) -> None:
        for path in ('/api/v2/links/acme/key', '/api/v1/hooks/acme/key', '/api/v1/links/acme/other',
                     '/api/v1/links/acme', '/api/v1/links/acme/key/more'):
            with self.subTest(path=path):
                status, body = self.api('POST', path, 'old')
                self.assertEqual(status, 404)
                self.assertEqual(body.get('message'), 'Not found.')
        self.assertTrue(self.current_hash_matches('old'), 'no other path may change the key')


ADDRESS = '203.0.113.7'
OTHER_ADDRESS = '203.0.113.8'
NOW = 1_800_000_000
NOT_JSON = 'The body is not valid JSON.'
NOT_AN_OBJECT = 'The body must be a JSON object.'
BAD_NAME_FIELD = 'name must be a non-empty string, or left out for a random one.'
BAD_NAME = ('Use lowercase letters, digits and hyphens, 1-63 characters, '
            'no hyphen at either end and none in the 3rd and 4th place.')
TOO_MANY = 'Too many new links from this address, try again later.'


class BindingRequestTests(RelayInProcess):
    """POST /api/v1/bindings as a caller sees it: each refusal, each limit and the answer."""

    def post(self, raw: str = '{}', content_type: str | None = 'application/json',
             ip: str = ADDRESS) -> tuple[int, str | None, dict]:
        """Send a body exactly as given, at a fixed time, and read status, Retry-After and JSON."""
        headers = {'X-Forwarded-For': ip}
        if content_type is not None:
            headers['Content-Type'] = content_type
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        self.addCleanup(connection.close)
        with patch.object(self.relay, 'now', return_value=NOW):
            connection.request('POST', '/api/v1/bindings', body=raw, headers=headers)
            response = connection.getresponse()
            return response.status, response.getheader('Retry-After'), json.loads(response.read())

    def post_name(self, name: object) -> tuple[int, str | None, dict]:
        return self.post(json.dumps({'name': name}))

    def created_before(self, age: int, count: int, ip: str = ADDRESS) -> None:
        with self.relay.transaction():
            for _ in range(count):
                self.relay.write('INSERT INTO creations (ip, at) VALUES (?, ?)', (ip, NOW - age))

    def assert_refused(self, answer: tuple[int, str | None, dict], status: int, code: str, message: str) -> None:
        self.assertEqual(answer[0], status)
        self.assertEqual(answer[2].get('error'), code)
        self.assertEqual(answer[2].get('message'), message)

    def assert_limited(self, answer: tuple[int, str | None, dict], retry_after: str) -> None:
        self.assert_refused(answer, 429, 'rate_limited', TOO_MANY)
        self.assertEqual(answer[1], retry_after)

    def test_binding_wants_a_json_content_type(self) -> None:
        for content_type in (None, 'text/plain', 'application/jsonx', 'text/plain; application/json'):
            with self.subTest(content_type=content_type):
                self.assert_refused(self.post(content_type=content_type), 415, 'unsupported_media_type',
                                    'Send the body as application/json.')
        self.assertEqual(self.counts(), (1, 0))
        self.assertEqual(self.post(content_type='Application/JSON ; charset=utf-8')[0], 201)

    def test_binding_refuses_a_body_it_cannot_use(self) -> None:
        for raw, message in (('{', NOT_JSON), ('x' * 4097, NOT_JSON),
                             ('[]', NOT_AN_OBJECT), ('"acme"', NOT_AN_OBJECT)):
            with self.subTest(raw=raw[:8]):
                self.assert_refused(self.post(raw), 400, 'invalid', message)
        self.assertEqual(self.counts(), (1, 0))

    def test_binding_name_must_be_a_non_empty_string(self) -> None:
        for name in ('', 5, 0, True, False, [], ['acme'], {}):
            with self.subTest(name=name):
                self.assert_refused(self.post_name(name), 400, 'invalid', BAD_NAME_FIELD)
        self.assertEqual(self.counts(), (1, 0))

    def test_binding_refuses_a_name_it_may_not_give(self) -> None:
        for name, status, code, message in (('bad_name', 400, 'invalid', BAD_NAME),
                                            ('www', 409, 'reserved', 'www.hornhoof.org is reserved.'),
                                            ('ACME', 409, 'taken', 'acme.hornhoof.org is taken.'),
                                            ('globex\n', 400, 'invalid', BAD_NAME),
                                            ('www\n', 400, 'invalid', BAD_NAME),
                                            ('acme\n', 400, 'invalid', BAD_NAME)):
            with self.subTest(name=name):
                self.assert_refused(self.post_name(name), status, code, message)
        self.assertEqual(self.counts(), (1, 0))

    def test_admin_add_refuses_a_name_with_a_trailing_newline(self) -> None:
        # admin add prints a key when it succeeds, so stdout stays out of the test's own output.
        with redirect_stdout(StringIO()), redirect_stderr(StringIO()) as refusal:
            self.assertEqual(self.relay.admin(['add', 'globex\n']), 1)
        self.assertIn('invalid', refusal.getvalue())
        self.assertEqual(self.counts(), (1, 0))

    def test_binding_without_a_name_gets_a_random_one(self) -> None:
        for raw in ('{}', '', '{"name": null}'):
            with self.subTest(raw=raw):
                status, _retry, body = self.post(raw, ip=f'198.51.100.{len(raw)}')
                self.assertEqual(status, 201)
                self.assertTrue(re.fullmatch(r'[a-z0-9]{24}', str(body.get('name'))) is not None,
                                'a random binding must have a fresh random name')

    def test_binding_answers_and_stores_the_name_it_gave(self) -> None:
        with patch.object(self.relay, '_dash_get', return_value=(404, b'{}')):
            status, _retry, body = self.post_name('GloBex')
        self.assertEqual(status, 201)
        self.assertEqual(sorted(body), ['key', 'name', 'tunnel', 'url'])
        self.assertEqual(body['name'], 'globex')
        self.assertEqual(body['url'], 'https://globex.hornhoof.org')
        conn = self.relay.db()
        row = conn.execute("SELECT key_hash, created_at, created_ip FROM bindings WHERE name = 'globex'").fetchone()
        self.assertTrue(row == (self.relay.key_hash(body['key']), NOW, ADDRESS),
                        'the binding must store the hash of the key it answered with')
        self.assertEqual(conn.execute('SELECT ip, at FROM creations').fetchall(), [(ADDRESS, NOW)])

    def test_binding_limit_per_address_waits_for_its_oldest(self) -> None:
        self.created_before(100, 4)
        self.assertEqual(self.post()[0], 201)
        counts = self.counts()
        self.assert_limited(self.post(), '3500')
        self.assertEqual(self.counts(), counts)
        self.assertEqual(self.post(ip=OTHER_ADDRESS)[0], 201)

    def test_binding_limit_forgets_what_is_older_than_an_hour(self) -> None:
        self.created_before(3601, 5)
        self.assertEqual(self.post()[0], 201)
        self.assertEqual(self.counts(), (2, 1))

    def test_binding_limit_keeps_what_is_exactly_an_hour_old(self) -> None:
        self.created_before(3600, 5)
        self.assert_limited(self.post(), '1')

    def test_binding_limit_for_all_addresses(self) -> None:
        self.created_before(100, 299, OTHER_ADDRESS)
        self.assertEqual(self.post()[0], 201)
        self.assert_limited(self.post(), '600')

    def test_binding_limit_per_address_goes_before_the_one_for_all(self) -> None:
        self.created_before(100, 5)
        self.created_before(100, 295, OTHER_ADDRESS)
        self.assert_limited(self.post(), '3500')


def raw_request(method: str, path: str, body: bytes = b'', headers: tuple[str, ...] = (),
                framed: bool = True) -> bytes:
    """One HTTP/1.1 request as bytes; framed gives it the Content-Length a proxy would send for its body."""
    lines = [f'{method} {path} HTTP/1.1', 'Host: relay', *headers]
    if framed:
        lines.append(f'Content-Length: {len(body)}')
    return '\r\n'.join(lines).encode() + b'\r\n\r\n' + body


JSON_BODY = 'Content-Type: application/json'
# What Caddy adds to everything that comes from outside; a smuggled request has none.
FROM_OUTSIDE = 'X-Forwarded-For: 198.51.100.99'
WRONG_KEY = 'Authorization: Bearer wrong'
GOOD_KEY = 'Authorization: Bearer old'
SMUGGLED_BINDING = raw_request('POST', '/api/v1/bindings', b'{}', (JSON_BODY,))
SMUGGLED_PLUGIN_CALL = raw_request('POST', '/frp/handler', b'{"op":"Ping","content":{}}', (JSON_BODY,))
# Each is less than a declared 20 bytes. Some would pass as a whole body if the shortfall went unnoticed.
CUT_SHORT_BODIES = (('no bytes', b''), ('only whitespace', b'  '), ('a whole value', b'{}'),
                    ('part of a value', b'{"na'))


class Exchange(NamedTuple):
    """What came back on one connection; raw may hold a generated key, so no assertion prints it."""
    raw: bytes
    closed: bool

    @property
    def statuses(self) -> list[int]:
        # Not anchored to a line: a second answer follows the first one's JSON with no line break.
        return [int(code) for code in re.findall(rb'HTTP/1\.1 (\d{3}) ', self.raw)]

    @property
    def says_close(self) -> bool:
        return re.search(rb'(?im)^connection: close\r$', self.raw) is not None


class ConnectionTests(RelayInProcess):
    """Bytes a request leaves unread must never run as the next one: they would come from 127.0.0.1, unforwarded."""

    def exchange(self, request: bytes, within: float = 3.0, hang_up: bool = False) -> Exchange:
        """hang_up ends the sending side after the request, as a client that drops does; the answer stays readable."""
        connection = socket.create_connection(('127.0.0.1', self.port), timeout=within)
        self.addCleanup(connection.close)
        connection.sendall(request)
        if hang_up:
            connection.shutdown(socket.SHUT_WR)
        raw = b''
        try:
            while chunk := connection.recv(65536):
                raw += chunk
        except TimeoutError:
            return Exchange(raw, closed=False)
        except ConnectionResetError:
            pass
        return Exchange(raw, closed=True)

    def assert_answered_once_and_closed(self, exchange: Exchange, status: int) -> None:
        self.assertEqual(exchange.statuses, [status], 'exactly one answer: the unread bytes must not run')
        self.assertTrue(exchange.closed, 'the connection must close once a request leaves bytes unread')
        self.assertTrue(exchange.says_close, 'the answer must say Connection: close, so that Caddy does not reuse it')

    def test_unread_body_never_runs_as_a_request(self) -> None:
        for method, path, headers, status in (
                ('POST', KEY_PATH, (WRONG_KEY,), 401),
                ('POST', '/api/v1/links/nobody/key', (WRONG_KEY,), 404),
                ('POST', '/api/v1/links/acme/visitor-key', (WRONG_KEY,), 401),
                ('POST', SYNC_PATH, (WRONG_KEY,), 401),
                ('POST', '/api/v1/links/acme/sync', (GOOD_KEY, 'Content-Type: text/plain'), 415),
                ('DELETE', '/api/v1/bindings/acme', (WRONG_KEY,), 401),
                ('DELETE', '/api/v1/bindings/nobody', (WRONG_KEY,), 404),
                ('POST', '/api/v1/bindings', ('Content-Type: text/plain',), 415),
                ('POST', '/frp/handler', (), 403),
                ('POST', '/api/v1/nothing', (), 404),
                ('DELETE', '/api/v1/nothing', (), 404),
                ('GET', ROUTE_PATH, (WRONG_KEY,), 401),
                ('GET', '/api/v1/names/acme', (), 200),
                ('GET', '/api/v1/nothing', (), 404),
                ('PUT', KEY_PATH, (), 501)):
            with self.subTest(method=method, path=path):
                request = raw_request(method, path, SMUGGLED_BINDING, (FROM_OUTSIDE, *headers))
                self.assert_answered_once_and_closed(self.exchange(request), status)
                self.assertEqual(self.counts(), (1, 0), 'the smuggled request must not make a binding')

    def test_a_plugin_call_in_a_body_never_reaches_the_plugin(self) -> None:
        request = raw_request('POST', KEY_PATH, SMUGGLED_PLUGIN_CALL, (FROM_OUTSIDE, WRONG_KEY))
        self.assert_answered_once_and_closed(self.exchange(request), 401)

    def test_transfer_encoding_closes_the_connection(self) -> None:
        chunked = f'{len(SMUGGLED_BINDING):x}'.encode() + b'\r\n' + SMUGGLED_BINDING + b'\r\n0\r\n\r\n'
        chunk = 'Transfer-Encoding: chunked'
        for label, request, status in (
                ('real chunks',
                 raw_request('POST', KEY_PATH, chunked, (FROM_OUTSIDE, WRONG_KEY, chunk), framed=False), 401),
                ('request right after the headers',
                 raw_request('POST', KEY_PATH, SMUGGLED_BINDING, (FROM_OUTSIDE, WRONG_KEY, chunk), framed=False), 401),
                ('any coding',
                 raw_request('POST', KEY_PATH, SMUGGLED_BINDING,
                             (FROM_OUTSIDE, WRONG_KEY, 'Transfer-Encoding: gzip, chunked'), framed=False), 401),
                ('a route that reads its body',
                 raw_request('POST', SYNC_PATH, b'{}' + SMUGGLED_BINDING,
                             (FROM_OUTSIDE, GOOD_KEY, JSON_BODY, chunk, 'Content-Length: 2'), framed=False), 400),
                ('the plugin, whose calls keep their connection',
                 raw_request('POST', '/frp/handler', SMUGGLED_BINDING, (JSON_BODY, chunk), framed=False), 200)):
            with self.subTest(label=label):
                self.assert_answered_once_and_closed(self.exchange(request), status)
                self.assertEqual(self.counts(), (1, 0), 'the smuggled request must not make a binding')

    def test_a_length_that_cannot_be_trusted_reads_nothing(self) -> None:
        body = b'{}' + SMUGGLED_BINDING
        for lengths in (('abc',), ('-5',), ('+2',), ('0_2',), ('2', str(len(body))), ('2', '2')):
            with self.subTest(lengths=lengths):
                headers = (FROM_OUTSIDE, JSON_BODY, *(f'Content-Length: {length}' for length in lengths))
                request = raw_request('POST', '/api/v1/bindings', body, headers, framed=False)
                self.assert_answered_once_and_closed(self.exchange(request), 400)
                self.assertEqual(self.counts(), (1, 0), 'neither this request nor the smuggled one may make a binding')

    def test_a_body_over_the_limit_closes_the_connection(self) -> None:
        request = raw_request('POST', '/api/v1/bindings', b'x' * 4097, (FROM_OUTSIDE, JSON_BODY))
        self.assert_answered_once_and_closed(self.exchange(request), 400)

    def test_a_big_unread_body_still_gets_its_answer(self) -> None:
        request = raw_request('POST', KEY_PATH, b'x' * 65536, (FROM_OUTSIDE, WRONG_KEY))
        self.assert_answered_once_and_closed(self.exchange(request), 401)

    def key_from_a_kept_connection(self, path: str, field: str) -> str:
        """A key request with the largest allowed body and a good request behind it: both run on one connection."""
        largest_body = b'{' + b' ' * 4094 + b'}'
        good = raw_request('GET', '/api/v1/names/acme', headers=(FROM_OUTSIDE,), framed=False)
        exchange = self.exchange(raw_request('POST', path, largest_body, (FROM_OUTSIDE, GOOD_KEY)) + good, within=0.5)
        self.assertEqual(exchange.statuses, [200, 200], 'the body must be read, so that the next request is whole')
        self.assertFalse(exchange.closed, 'nothing is left unread, so the connection stays')
        self.assertFalse(exchange.says_close, 'nothing is left unread, so the answer must not say close')
        answer = exchange.raw.split(b'\r\n\r\n', 1)[1].decode()
        return json.JSONDecoder().raw_decode(answer)[0][field]

    def test_a_new_link_key_comes_with_its_body_read(self) -> None:
        """The answer is the only copy of a committed key; closing over unread bytes can reset it away."""
        new = self.key_from_a_kept_connection(KEY_PATH, 'key')
        self.assertTrue(self.current_hash_matches(new), 'the answer must hold the key that was stored')

    def test_a_new_visitor_key_comes_with_its_body_read(self) -> None:
        new = self.key_from_a_kept_connection(VISITOR_KEY_PATH, 'visitorKey')
        self.assertTrue(self.relay.visitor_hash_matches('acme', new), 'the answer must hold the key that was stored')

    def give_back_the_old_key(self) -> None:
        """So that one case that wrongly changed a key cannot make the next case fail for that reason."""
        self.relay.write('UPDATE bindings SET key_hash = ? WHERE name = ?', (self.relay.key_hash('old'), 'acme'))
        self.relay.write('DELETE FROM ping_keys WHERE name = ?', ('acme',))
        self.relay.write('DELETE FROM visitor_keys WHERE name = ?', ('acme',))

    def test_a_key_is_not_changed_by_a_body_it_cannot_read(self) -> None:
        chunked = b'2\r\n{}\r\n0\r\n\r\n'
        for path in (KEY_PATH, VISITOR_KEY_PATH):
            for label, body, headers, framed in (
                    ('one byte over the limit', b'{"pad":"' + b'x' * 4087 + b'"}', (), True),
                    ('not JSON', b'{', (), True),
                    ('not text', b'\xff', (), True),
                    ('chunked', chunked, ('Transfer-Encoding: chunked',), False),
                    ('a length that cannot be trusted', b'{}', ('Content-Length: +2',), False)):
                with self.subTest(path=path, label=label):
                    self.give_back_the_old_key()
                    request = raw_request('POST', path, body, (FROM_OUTSIDE, GOOD_KEY, *headers), framed)
                    exchange = self.exchange(request, within=0.5)
                    self.assertEqual(exchange.statuses, [400], 'refused before anything changes')
                    self.assertTrue(b'ey":' not in exchange.raw, 'a refusal must hand out no key')
                    self.assertTrue(self.current_hash_matches('old'), 'the old key must still be the key')
                    self.assertEqual(self.lifetime_rows(), {'visitor_keys': 0, 'ping_keys': 0, 'sync': 0})

    def test_a_key_is_not_changed_by_a_body_cut_short(self) -> None:
        """A client that drops mid-request must not cost a company the key it knows."""
        for path in (KEY_PATH, VISITOR_KEY_PATH):
            for label, sent in CUT_SHORT_BODIES:
                with self.subTest(path=path, label=label):
                    self.give_back_the_old_key()
                    headers = (FROM_OUTSIDE, GOOD_KEY, 'Content-Length: 20')
                    request = raw_request('POST', path, sent, headers, framed=False)
                    self.assert_answered_once_and_closed(self.exchange(request, hang_up=True), 400)
                    self.assertTrue(self.current_hash_matches('old'), 'the old key must still be the key')
                    self.assertEqual(self.lifetime_rows(), {'visitor_keys': 0, 'ping_keys': 0, 'sync': 0})
        self.give_back_the_old_key()
        self.assertEqual(self.api('POST', KEY_PATH, 'old')[0], 200, 'the old key must still work')

    def test_a_binding_is_not_made_from_a_body_cut_short(self) -> None:
        for label, sent in CUT_SHORT_BODIES:
            with self.subTest(label=label):
                request = raw_request('POST', '/api/v1/bindings', sent, (FROM_OUTSIDE, JSON_BODY, 'Content-Length: 20'),
                                      framed=False)
                self.assert_answered_once_and_closed(self.exchange(request, hang_up=True), 400)
                self.assertEqual(self.counts(), (1, 0), 'no binding and no used creation')

    def test_a_chunked_binding_makes_nothing(self) -> None:
        """Its key would be the only copy too, on an answer that closes over the unread chunks."""
        request = raw_request('POST', '/api/v1/bindings', b'2\r\n{}\r\n0\r\n\r\n',
                              (FROM_OUTSIDE, JSON_BODY, 'Transfer-Encoding: chunked'), framed=False)
        self.assert_answered_once_and_closed(self.exchange(request), 400)
        self.assertEqual(self.counts(), (1, 0))

    def test_clean_requests_keep_their_connection(self) -> None:
        plugin_call = raw_request('POST', '/frp/handler', b'{"op":"Ping","content":{}}', (JSON_BODY,))
        for label, request, statuses in (
                ('plugin calls, twice', plugin_call * 2, [200, 200]),
                ('no body and no length', raw_request('GET', '/api/v1/names/acme', framed=False), [200]),
                ('an empty body', raw_request('POST', KEY_PATH, b'', (GOOD_KEY,)), [200]),
                ('a body read in full', raw_request('POST', '/api/v1/bindings', b'{}', (JSON_BODY,)), [201])):
            with self.subTest(label=label):
                exchange = self.exchange(request, within=0.5)
                self.assertEqual(exchange.statuses, statuses)
                self.assertFalse(exchange.closed, 'a clean request must keep its connection')
                self.assertFalse(exchange.says_close, 'a clean answer must not say Connection: close')


def frps_shows_nothing(_path: str, cap: float = 0.5) -> tuple[int, bytes]:
    return 404, b'{}'


def frps_shows_acme_online(path: str, cap: float = 0.5) -> tuple[int, bytes]:
    if '/https/' in path:
        return 200, b'{"status":"online","clientID":"acme-aaaaaaaa-link"}'
    return 404, b'{}'


def frps_cannot_tell(_path: str, cap: float = 0.5) -> tuple[int, bytes]:
    return 500, b''


class FreedNameTests(RelayInProcess):
    """A name's change of owner, at the plugin and the API, with a stand-in for frps's dashboard, so that each step lands
    exactly where a real frps could put it and no test waits for a moment to come. frps asks the plugin before it makes a
    proxy, so that between that answer and its dashboard showing the proxy, only the relay's row knows of the route."""

    NOW = 1_900_000_000

    def registration(self, key: str = 'old') -> dict:
        metas = {'name': 'acme', 'key': key, 'client': 'acme-aaaaaaaa-link'}
        return {'user': {'user': '', 'metas': metas, 'run_id': 'r1'},
                'proxy_name': 'acme', 'proxy_type': 'https', 'subdomain': 'acme'}

    def new_connection(self, key: str) -> dict:
        return {'user': {'user': '', 'metas': {'name': 'acme', 'key': key}, 'run_id': 'r1'},
                'proxy_name': 'acme', 'proxy_type': 'https', 'remote_addr': '203.0.113.9:40000'}

    def at(self, seconds_later: int = 0):
        return patch.object(self.relay, 'now', return_value=self.NOW + seconds_later)

    def assert_passed(self, op: str, content: dict) -> None:
        answer = self.relay.plugin(op, content)
        self.assertIs(answer['reject'], False, answer.get('reject_reason'))

    def assert_taken(self) -> None:
        self.assertEqual(self.api('GET', '/api/v1/names/acme'),
                         (200, {'name': 'acme', 'free': False, 'reason': 'taken'}))
        status, body = self.api('POST', '/api/v1/bindings', body={'name': 'acme'})
        self.assertEqual(status, 409, 'the name must not go to a new owner')
        self.assertTrue(body.get('error') == 'taken', 'the refusal must say taken')
        self.assertEqual(self.counts(), (0, 0), 'a refused binding stores nothing')

    def bind_acme_for_the_next_owner(self) -> str:
        status, body = self.api('POST', '/api/v1/bindings', body={'name': 'acme'})
        self.assertEqual(status, 201, 'the name is free for its next owner')
        return body['key']

    def test_r1_5_a_freed_name_waits_for_a_route_frps_has_not_shown_yet(self) -> None:
        with patch.object(self.relay, '_dash_get', frps_shows_nothing):
            self.assert_passed('NewProxy', self.registration())
            self.assertEqual(self.api('DELETE', '/api/v1/bindings/acme', 'old')[0], 204)
            self.assert_taken()
        with patch.object(self.relay, '_dash_get', frps_shows_acme_online):
            self.assert_taken()

    def test_r1_5_a_route_frps_never_showed_frees_the_name_after_its_window(self) -> None:
        with patch.object(self.relay, '_dash_get', frps_shows_nothing):
            with self.at():
                self.assert_passed('NewProxy', self.registration())
                self.assertEqual(self.api('DELETE', '/api/v1/bindings/acme', 'old')[0], 204)
            with self.at(self.relay.PENDING_S):
                self.assert_taken()
            with self.at(self.relay.PENDING_S + 1):
                self.assertEqual(self.api('GET', '/api/v1/names/acme'), (200, {'name': 'acme', 'free': True}))
                self.bind_acme_for_the_next_owner()


    def while_frps_is_first_read(self, happening: Callable[[], None]):
        """frps's dashboard shows nothing, and this happens at its first read. In a NewProxy, that read comes after the
        call's login check and before its row lands, which is the moment a release or a ban could come in."""
        waiting = [happening]

        def dashboard(_path: str, cap: float = 0.5) -> tuple[int, bytes]:
            if waiting:
                waiting.pop()()
            return 404, b'{}'

        return patch.object(self.relay, '_dash_get', dashboard)

    def test_r1_5_a_route_shown_while_the_name_is_checked_still_counts(self) -> None:
        # A route read of the old owner, begun before its release, may turn the row held after frps was read for the name.
        def the_row_turns_held() -> None:
            self.relay.write("UPDATE routes SET state = 'held' WHERE name = 'acme'", ())

        with patch.object(self.relay, '_dash_get', frps_shows_nothing):
            self.assert_passed('NewProxy', self.registration())
            self.free_acme()
        with self.while_frps_is_first_read(the_row_turns_held):
            self.assertEqual(self.api('GET', '/api/v1/names/acme'),
                             (200, {'name': 'acme', 'free': False, 'reason': 'taken'}))

    def route_rows(self) -> list[tuple]:
        return self.relay.db().execute('SELECT name, generation FROM routes').fetchall()

    def assert_registration_refused(self, meanwhile: Callable[[], None], reason: str) -> None:
        with self.while_frps_is_first_read(meanwhile):
            answer = self.relay.plugin('NewProxy', self.registration())
        self.assertEqual(answer, {'reject': True, 'reject_reason': reason})
        self.assertEqual(self.route_rows(), [], 'a refused registration moves no generation')

    def free_acme(self) -> None:
        self.assertEqual(self.api('DELETE', '/api/v1/bindings/acme', 'old')[0], 204)

    def test_r1_1_a_registration_racing_a_release_is_refused(self) -> None:
        self.assert_registration_refused(self.free_acme, 'no binding acme with this key')

    def test_r1_1_a_registration_racing_a_ban_is_refused(self) -> None:
        self.assert_registration_refused(lambda: self.relay.store_ban('acme', 'a test'), 'acme.hornhoof.org is blocked')

    def test_r6_1_a_registration_racing_a_key_change_is_refused(self) -> None:
        def change_the_key() -> None:
            self.assertEqual(self.api('POST', KEY_PATH, 'old')[0], 200)

        self.assert_registration_refused(change_the_key, 'no binding acme with this key')

    def test_r1_1_a_registration_racing_a_new_owner_never_reaches_it(self) -> None:
        next_owner = []

        def freed_and_bound_again() -> None:
            self.free_acme()
            next_owner.append(self.bind_acme_for_the_next_owner())

        self.assert_registration_refused(freed_and_bound_again, 'no binding acme with this key')
        with patch.object(self.relay, '_dash_get', frps_shows_nothing):
            status, route = self.api('GET', ROUTE_PATH, next_owner[0])
        self.assertEqual((status, route['state'], route['generation']), (200, 'empty', 0))

    def operators_add(self) -> tuple[int, str, str]:
        """(exit code, what it said, what it refused with). What it said holds the key once it adds: never print it."""
        with redirect_stdout(StringIO()) as said, redirect_stderr(StringIO()) as refusal:
            code = self.relay.admin(['add', 'acme'])
        return code, said.getvalue(), refusal.getvalue()

    def assert_operators_add_refused(self, reason: str) -> None:
        code, said, refusal = self.operators_add()
        self.assertEqual(code, 1, 'the name must not go to a new owner')
        self.assertIn(reason, refusal)
        self.assertTrue(said == '', 'a refused name must hand out no key')
        self.assertEqual(self.counts(), (0, 0), 'a refused name stores nothing')

    def test_r1_5_an_operators_add_refuses_a_route_frps_shows(self) -> None:
        self.free_acme()
        with patch.object(self.relay, '_dash_get', frps_shows_acme_online):
            self.assert_operators_add_refused('acme: taken')

    def test_r1_5_an_operators_add_refuses_a_route_frps_has_not_shown_yet(self) -> None:
        with patch.object(self.relay, '_dash_get', frps_shows_nothing):
            with self.at():
                self.assert_passed('NewProxy', self.registration())
                self.free_acme()
                self.assert_operators_add_refused('acme: taken')
            with self.at(self.relay.PENDING_S + 1):
                self.assertEqual(self.operators_add()[0], 0, 'a route frps never showed frees the name after its window')

    def test_r1_5_an_operators_add_refuses_while_frps_cannot_tell(self) -> None:
        self.free_acme()
        with patch.object(self.relay, '_dash_get', frps_cannot_tell):
            self.assert_operators_add_refused(
            'acme: the relay cannot reach frps to check the name, nothing changed; see the frps settings in /etc/hornhoof-relay.env\n')

    def test_r1_5_an_operators_add_of_a_free_name_makes_the_binding(self) -> None:
        self.free_acme()
        with patch.object(self.relay, '_dash_get', frps_shows_nothing):
            code, said, _ = self.operators_add()
        self.assertEqual(code, 0, 'a free name must bind')
        self.assertTrue(self.current_hash_matches(json.loads(said)['key']), 'the key it hands out must be the key')

    def test_r7_4_an_old_owners_route_is_refused_under_a_new_binding(self) -> None:
        # frps shows the route later than the window allows for, when the name already has its next owner.
        with patch.object(self.relay, '_dash_get', frps_shows_nothing):
            with self.at():
                self.assert_passed('NewProxy', self.registration())
                self.free_acme()
            with self.at(self.relay.PENDING_S + 1):
                next_key = self.bind_acme_for_the_next_owner()
        self.assertEqual(self.relay.plugin('NewUserConn', self.new_connection('old')),
                         {'reject': True, 'reject_reason': 'freed'})
        self.assert_passed('NewUserConn', self.new_connection(next_key))

if __name__ == '__main__':
    unittest.main()
