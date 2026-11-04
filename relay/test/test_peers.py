"""Client ids, two companies on one machine, peer services and visitor keys: R1.3, R1.4, R5.1, R6.2."""

import base64
import hashlib
import http.client
import json
import os
import secrets
import socket
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from relay.relay import EVICTION_BOUND_S, FrpsUnknown, dash_client_records

if __package__:
    from .harness import Stack, _request, _wait
else:
    from harness import Stack, _request, _wait

# Not resolve(): a mutator worker symlinks this file, and its own copy of relay.py must be the one that loads.
ROOT = Path(__file__).absolute().parents[2]
M8 = '3f2a9c1b'


def _relay_module():
    """relay.py imported in-process, like DashboardContractTests in test_route.py."""
    import importlib.util
    spec = importlib.util.spec_from_file_location('relay_peers_under_test', ROOT / 'relay' / 'relay.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
PEER = f'acme-{M8}-peer'
VISITOR = 'acme-77aa0011-visit'


class PeerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-peers-'))
        self.stack = self.enterContext(Stack(self.tmp))
        self.binding = self.stack.bind('acme')
        self.key = self.binding['key']

    # Direct plugin and API posts

    def plugin_post(self, op: str, content: dict) -> dict:
        status, body = _request(self.stack.relay_port, 'POST', '/frp/handler',
                                json.dumps({'op': op, 'content': content}).encode(),
                                {'Content-Type': 'application/json'})
        self.assertEqual(status, 200, body)
        return json.loads(body)

    def login(self, metas: dict, client_id: str = '', run_id: str = '') -> dict:
        return self.plugin_post('Login', {'metas': metas, 'client_id': client_id, 'run_id': run_id})

    def link_metas(self, client: str | None = None) -> dict:
        metas = {'name': 'acme', 'key': self.key}
        if client is not None:
            metas['client'] = client
        return metas

    def newproxy(self, metas: dict, proxy_name: str, proxy_type: str, run_id: str = '', **extra) -> dict:
        content = {'user': {'user': '', 'metas': metas, 'run_id': run_id},
                   'proxy_name': proxy_name, 'proxy_type': proxy_type}
        content.update(extra)
        return self.plugin_post('NewProxy', content)

    def visitor_key(self, name: str = 'acme', key: str | None = None) -> tuple[int, dict | None]:
        return self.stack.api('POST', f'/api/v1/links/{name}/visitor-key', key=self.key if key is None else key)

    def stcp_proxies(self, *services: tuple[str, str, int]) -> str:
        blocks = []
        for name, sk, port in services:
            blocks.append(f'''
[[proxies]]
name = "{name}"
type = "stcp"
secretKey = "{sk}"
localIP = "127.0.0.1"
localPort = {port}
''')
        return '\n'.join(blocks)

    def extra_echo(self, marker: str) -> int:
        """A second echo server that names itself in its answer, so a test can tell which
        service answered. Cleanup is registered first, so both servers stop even when the
        test fails."""

        class _NamedEcho(BaseHTTPRequestHandler):
            def do_GET(self):
                data = json.dumps({'service': marker, 'path': self.path}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_POST = do_GET
            do_PUT = do_GET

            def log_message(self, fmt, *args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), _NamedEcho)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_port

    def visitor_proxy(self, server_name: str, secret: str, port: int) -> str:
        return f'''
[[visitors]]
name = "{server_name}-visit"
type = "stcp"
serverName = "{server_name}"
secretKey = "{secret}"
bindAddr = "127.0.0.1"
bindPort = {port}
'''

    def echo(self, port: int, path: str = '/through-the-relay') -> str:
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
        try:
            connection.request('GET', path)
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            return response.read().decode()
        finally:
            connection.close()

    def echo_closes_silent(self, port: int) -> None:
        """A wrong secret closes the visitor's connection with no answer: zero raw bytes
        before EOF or a reset. An HTTP answer with an empty body, or a connection that
        stays open, is not a silent close (probed against a plain 200/403 in TMPDIR)."""
        sock = socket.create_connection(('127.0.0.1', port), timeout=10)
        try:
            try:
                sock.sendall(b'GET /through-the-relay HTTP/1.1\r\nHost: probe\r\nConnection: close\r\n\r\n')
            except (ConnectionResetError, BrokenPipeError):
                return  # reset before the request went out: still no answer
            received = b''
            while True:
                try:
                    chunk = sock.recv(4096)
                except (ConnectionResetError, BrokenPipeError):
                    break
                except socket.timeout:
                    self.fail('the connection stayed open with no answer; a timeout is not a silent close')
                if not chunk:
                    break
                received += chunk
            self.assertEqual(received, b'')
        finally:
            sock.close()

    def test_r1_3_blocked_binding_refused(self) -> None:
        with sqlite3.connect(self.stack.env['RELAY_DB']) as conn:
            conn.execute("UPDATE bindings SET banned_at = 1, ban_reason = 'test' WHERE name = 'acme'")
        answer = self.login(self.link_metas('acme-3f2a9c1b-link'), 'acme-3f2a9c1b-link')
        self.assertEqual(answer, {'reject': True, 'reject_reason': 'acme.hornhoof.org is blocked'})

    def test_r1_3_run_id_check_fails_closed_when_frps_cannot_tell(self) -> None:
        client = self.stack.client('acme', self.key, settings='network', client='acme-3f2a9c1b-link')
        self.assertTrue(client.started('acme'), client.log())
        self.stack.stop_frps()
        answer = self.login(self.link_metas('acme-3f2a9c1b-link'), 'acme-3f2a9c1b-link', 'any-run-id')
        self.assertEqual(answer, {'reject': True, 'reject_reason': 'relay error: frps does not answer'})

    def test_dash_client_records_shape_pinned_fail_closed(self) -> None:
        # The relay reads GET /api/clients?runId= on a login with a client id; an answer
        # that lacks a field reads as unknown, never as "no session".
        good = json.dumps([{'clientID': 'acme-3f2a9c1b-link', 'online': True}]).encode()
        self.assertEqual(dash_client_records(good), [{'clientID': 'acme-3f2a9c1b-link', 'online': True}])
        bad = (b'{', b'{}', json.dumps('x').encode(), json.dumps([{'clientID': 'c'}]).encode(),
               json.dumps([{'clientID': 'c', 'online': 'yes'}]).encode(),
               json.dumps([{'clientID': 1, 'online': True}]).encode(),
               json.dumps(['x']).encode(),
               json.dumps([{'clientID': '', 'online': True}]).encode())
        for body in bad:
            with self.subTest(body=body):
                with self.assertRaises(FrpsUnknown):
                    dash_client_records(body)

    def test_r1_4_two_companies_one_machine(self) -> None:
        globex = self.stack.bind('globex')
        acme_client = self.stack.client('acme', self.key, settings='network', client='acme-3f2a9c1b-link')
        globex_client = self.stack.client('globex', globex['key'], settings='network',
                                          client='globex-3f2a9c1b-link')
        self.assertTrue(acme_client.started('acme'), acme_client.log())
        self.assertTrue(globex_client.started('globex'), globex_client.log())
        for name, holder, key in (('acme', 'acme-3f2a9c1b-link', self.key),
                                  ('globex', 'globex-3f2a9c1b-link', globex['key'])):
            with self.subTest(name=name):
                status, route = self.stack.api('GET', f'/api/v1/links/{name}/route', key=key)
                self.assertEqual(status, 200, route)
                self.assertEqual(route['state'], 'held')
                self.assertEqual(route['client'], holder)
                self.assertEqual(route['generation'], 1)
                self.assertEqual(self.stack.get(f'{name}.hornhoof.org'), 200)

    def test_r1_3_second_login_same_id_refused(self) -> None:
        proxies = self.stcp_proxies((f'acme-{M8}-data', secrets.token_hex(20), self.stack.echo_port))
        first = self.stack.client('acme', self.key, settings='network', client=PEER, proxies=proxies)
        self.assertTrue(first.started(f'acme-{M8}-data'), first.log())
        first.pause()
        second = self.stack.client('acme', self.key, settings='network', client=PEER, proxies=proxies)
        self.assertTrue(_wait(lambda: 'is already online' in second.log(), 15), second.log())
        self.assertNotIn('login to server success', second.log())
        mark = len(self.stack.frps.log())
        self.assertTrue(
            _wait(lambda: 'client exit success' in self.stack.frps.log()[mark:], EVICTION_BOUND_S + 30),
            self.stack.frps.log()[mark:])
        dropped = time.monotonic()
        self.assertTrue(second.started(f'acme-{M8}-data', within=EVICTION_BOUND_S + 30), second.log())
        delay = time.monotonic() - dropped
        print(f'second login with one client id after the drop: {delay:.2f} s', flush=True)
        self.assertLessEqual(delay, EVICTION_BOUND_S + 30)

    def test_r1_3_run_id_of_another_client(self) -> None:
        client = self.stack.client('acme', self.key, settings='network', client='acme-3f2a9c1b-link')
        self.assertTrue(client.started('acme'), client.log())
        # Pin the dashboard answer shape the relay relies on: a bare JSON array of records
        # with a string clientID, a string runID and a boolean online.
        status, clients = self.stack.dash('/api/clients')
        self.assertEqual(status, 200)
        self.assertIsInstance(clients, list)
        run_id = None
        for entry in clients:
            self.assertIsInstance(entry, dict)
            self.assertIsInstance(entry.get('clientID'), str)
            self.assertIsInstance(entry.get('runID'), str)
            self.assertIs(type(entry.get('online')), bool)
            if entry['clientID'] == 'acme-3f2a9c1b-link' and entry['online']:
                run_id = entry['runID']
        self.assertTrue(run_id, clients)
        foreign = self.login(self.link_metas('acme-0000aaaa-link'), 'acme-0000aaaa-link', run_id)
        self.assertEqual(foreign, {'reject': True,
                                   'reject_reason': 'this run id belongs to another client'})
        own = self.login(self.link_metas('acme-3f2a9c1b-link'), 'acme-3f2a9c1b-link', run_id)
        self.assertEqual(own, {'reject': False, 'unchange': True})

    def online_run_id(self, client_id: str) -> str:
        """The run id of the live dashboard session for client_id, pinned on /api/clients."""
        status, clients = self.stack.dash('/api/clients')
        self.assertEqual(status, 200)
        for entry in clients:
            if entry['clientID'] == client_id and entry['online']:
                return entry['runID']
        self.fail(f'no online session for {client_id}: {clients}')

    def test_r1_3_legacy_login_with_foreign_run_id_refused(self) -> None:
        # C1: a legacy Login (empty client id, no metas.client) presenting another session's
        # live run id would displace that session in frps; the relay must refuse it.
        client = self.stack.client('acme', self.key, settings='network', client='acme-3f2a9c1b-link')
        self.assertTrue(client.started('acme'), client.log())
        run_id = self.online_run_id('acme-3f2a9c1b-link')
        legacy = {'name': 'acme', 'key': self.key}
        foreign = self.plugin_post('Login', {'metas': legacy, 'run_id': run_id})
        self.assertEqual(foreign, {'reject': True,
                                   'reject_reason': 'this run id belongs to another client'})
        # the victim's session is untouched: its route still names it
        status, route = self.stack.api('GET', '/api/v1/links/acme/route', key=self.key)
        self.assertEqual(status, 200, route)
        self.assertEqual(route['state'], 'held')
        self.assertEqual(route['client'], 'acme-3f2a9c1b-link')

    def test_r1_3_legacy_run_id_of_another_binding_refused(self) -> None:
        # C1: the run id of a legacy session recorded for another binding is not this
        # login's own, even though frps shows that session's clientID as the run id itself.
        globex = self.stack.bind('globex')
        globex_legacy = self.stack.client('globex', globex['key'])
        self.assertTrue(globex_legacy.started('globex'), globex_legacy.log())
        status, clients = self.stack.dash('/api/clients')
        self.assertEqual(status, 200)
        victims = [e for e in clients if e['online'] and e['clientID'] == e['runID']]
        self.assertEqual(len(victims), 1, clients)
        run_id = victims[0]['runID']
        foreign = self.plugin_post('Login', {'metas': {'name': 'acme', 'key': self.key},
                                             'run_id': run_id})
        self.assertEqual(foreign, {'reject': True,
                                   'reject_reason': 'this run id belongs to another client'})

    def test_r1_3_legacy_reconnection_kept(self) -> None:
        # A legacy frpc reconnecting with its own live run id is its own session: frps 0.71.1
        # shows a legacy client's runID as its clientID, so the run id names the session.
        legacy = self.stack.client('acme', self.key)
        self.assertTrue(legacy.started('acme'), legacy.log())
        status, clients = self.stack.dash('/api/clients')
        self.assertEqual(status, 200)
        entries = [e for e in clients if e['online']]
        self.assertEqual(len(entries), 1, clients)
        self.assertEqual(entries[0]['clientID'], entries[0]['runID'])
        again = self.plugin_post('Login', {'metas': {'name': 'acme', 'key': self.key},
                                           'run_id': entries[0]['runID']})
        self.assertEqual(again, {'reject': False, 'unchange': True})

    def test_dash_clients_run_id_filter_against_real_frps(self) -> None:
        # I5: the relay reads GET /api/clients?runId=<run_id>; pin the filtered shape on
        # real frps with a second online client, so an unfiltered /api/clients regression
        # (two records) fails here.
        first = self.stack.client('acme', self.key, settings='network', client='acme-3f2a9c1b-link')
        self.assertTrue(first.started('acme'), first.log())
        globex = self.stack.bind('globex')
        second = self.stack.client('globex', globex['key'], settings='network',
                                   client='globex-3f2a9c1b-link')
        self.assertTrue(second.started('globex'), second.log())
        run_id = self.online_run_id('acme-3f2a9c1b-link')
        status, filtered = self.stack.dash(f'/api/clients?runId={run_id}')
        self.assertEqual(status, 200)
        self.assertIsInstance(filtered, list)
        self.assertEqual(len(filtered), 1, filtered)
        self.assertEqual(filtered[0]['clientID'], 'acme-3f2a9c1b-link')
        self.assertEqual(filtered[0]['runID'], run_id)
        self.assertTrue(filtered[0]['online'])
        status, missing = self.stack.dash('/api/clients?runId=0fdeadbeef0fdeadbeef')
        self.assertEqual(status, 200)
        self.assertEqual(missing, [])

    def test_r1_3_foreign_client_id_refused(self) -> None:
        status, body = self.visitor_key()
        # I8: fixed message; the body carries the generated visitor key.
        self.assertEqual(status, 200, 'issuing a visitor key must answer 200')
        cases = (
            # Another company's link name in the client id, with acme's key.
            ('other-link-name', self.link_metas('globex-3f2a9c1b-link'), 'globex-3f2a9c1b-link'),
            # metadatas.client names another client than client_id.
            ('metas-client-mismatch', self.link_metas('acme-ffffffff-link'), 'acme-3f2a9c1b-link'),
            # A visitor-kind client id does not log in with the link key.
            ('visit-kind-with-link-key', self.link_metas('acme-3f2a9c1b-visit'), 'acme-3f2a9c1b-visit'),
            # A client id with a key kind does not log in with the visitor key.
            ('peer-kind-with-visitor-key', {'name': 'acme', 'visitor': body['visitorKey'], 'client': PEER}, PEER),
            # No client id, but metadatas.client names one.
            ('metas-client-without-client-id', self.link_metas('acme-3f2a9c1b-link'), ''),
            # A visitor-key session always needs a visit client id.
            ('visitor-key-without-client-id', {'name': 'acme', 'visitor': body['visitorKey']}, ''),
        )
        for label, metas, client_id in cases:
            # I8: labels and diagnostics never carry the metas (they hold keys).
            with self.subTest(case=label):
                answer = self.login(metas, client_id)
                self.assertEqual(answer, {'reject': True,
                                          'reject_reason': 'this client id is not for acme'})

    def test_r1_3_malformed_client_ids_refused(self) -> None:
        # I6: each id must match CLIENT over its whole length; a trailing newline must not
        # pass, and neither do a short or non-hex machine id, uppercase, or an unknown kind.
        cases = (
            'acme-3f2a9c1-link',        # the machine id is not 8 characters
            'acme-3f2a9c1z-link',       # the machine id is not hex
            'acme-3F2A9C1B-link',       # uppercase is not a network id
            'acme-3f2a9c1b-other',      # no kind other than link, peer and visit
            'acme-3f2a9c1b-link\n',    # nothing may follow the id
            'acme-3f2a9c1b-link extra',
        )
        for client_id in cases:
            with self.subTest(client_id=client_id):
                answer = self.login(self.link_metas(client_id), client_id)
                self.assertEqual(answer, {'reject': True,
                                          'reject_reason': 'this client id is not for acme'})

    def test_r1_3_non_string_ids_refused(self) -> None:
        # I6: a malformed id refuses; it never reads as a legacy login or stores a route.
        cases = (
            ('int-client-meta', {'name': 'acme', 'key': self.key, 'client': 7}, 7, 7),
            ('list-client-meta', {'name': 'acme', 'key': self.key, 'client': ['x']}, '', ''),
            ('null-client-meta', {'name': 'acme', 'key': self.key, 'client': None}, None, ''),
        )
        for label, metas, client_id, run_id in cases:
            # I8: labels and diagnostics never carry the metas (they hold keys).
            with self.subTest(case=label):
                answer = self.plugin_post('Login', {'metas': metas, 'client_id': client_id,
                                                    'run_id': run_id})
                self.assertEqual(answer, {'reject': True,
                                          'reject_reason': 'this client id is not for acme'})
        answer = self.plugin_post('Login', {'metas': self.link_metas('acme-3f2a9c1b-link'),
                                            'client_id': 'acme-3f2a9c1b-link', 'run_id': ['r']})
        self.assertEqual(answer, {'reject': True,
                                  'reject_reason': 'this run id belongs to another client'})
        # An empty run id is what a fresh session looks like before frps assigns one.
        answer = self.plugin_post('Login', {'metas': self.link_metas('acme-3f2a9c1b-link'),
                                            'client_id': 'acme-3f2a9c1b-link', 'run_id': ''})
        self.assertEqual(answer, {'reject': False, 'unchange': True})
        # A NewProxy with a non-string metas.client refuses before any route is recorded.
        answer = self.newproxy({'name': 'acme', 'key': self.key, 'client': ['x']},
                               'acme', 'http', subdomain='acme')
        self.assertEqual(answer, {'reject': True,
                                  'reject_reason': 'this client id is not for acme'})
        status, route = self.stack.api('GET', '/api/v1/links/acme/route', key=self.key)
        self.assertEqual(status, 200, route)
        self.assertEqual(route['generation'], 0)

    def test_newproxy_malformed_run_id_refused(self) -> None:
        # I6: a present non-string user.run_id refuses before any route lookup,
        # straightening or upsert: no row, no generation, the connection stays up.
        metas = self.link_metas('acme-3f2a9c1b-link')
        for value in (7, True, [], ['r'], None):
            with self.subTest(run_id_type=type(value).__name__):
                answer = self.plugin_post('NewProxy', {
                    'user': {'user': '', 'metas': metas, 'run_id': value},
                    'proxy_name': 'acme', 'proxy_type': 'http', 'subdomain': 'acme'})
                self.assertEqual(answer, {'reject': True,
                                          'reject_reason': 'this run id belongs to another client'})
        for user in (['x'], 'x', 7):
            with self.subTest(user_type=type(user).__name__):
                answer = self.plugin_post('NewProxy', {'user': user, 'proxy_name': 'acme',
                                                       'proxy_type': 'http'})
                self.assertTrue(answer.get('reject'), answer)
        status, route = self.stack.api('GET', '/api/v1/links/acme/route', key=self.key)
        self.assertEqual(status, 200, route)
        self.assertEqual(route['generation'], 0)
        with sqlite3.connect(f"file:{self.stack.env['RELAY_DB']}?mode=ro", uri=True) as conn:
            rows = conn.execute('SELECT COUNT(*) FROM routes WHERE name = ?', ('acme',)).fetchone()
        self.assertEqual(rows[0], 0)

    def route_row(self) -> tuple:
        with sqlite3.connect(f"file:{self.stack.env['RELAY_DB']}?mode=ro", uri=True) as conn:
            return conn.execute('SELECT generation, client, state, run_id FROM routes WHERE name = ?',
                                ('acme',)).fetchone()

    def test_newproxy_malformed_run_id_keeps_existing_route(self) -> None:
        # I6 on a live route: the malformed NewProxy must refuse before any
        # route lookup that could straighten the row. The row is set pending in
        # SQLite (a registration frps has not shown yet): any route API read
        # before validation would flip it back to held against the online frps
        # route, so the row is inspected directly, with no route read in between.
        client = self.stack.client('acme', self.key, settings='network', client='acme-3f2a9c1b-link')
        self.assertTrue(client.started('acme'), client.log())
        status, before = self.stack.api('GET', '/api/v1/links/acme/route', key=self.key)
        self.assertEqual(status, 200, before)
        self.assertEqual(before['state'], 'held')
        row_before = self.route_row()
        self.assertEqual(row_before[2], 'held')
        with sqlite3.connect(self.stack.env['RELAY_DB']) as conn:
            conn.execute("UPDATE routes SET state = 'pending' WHERE name = 'acme'")
        answer = self.plugin_post('NewProxy', {
            'user': {'user': '', 'metas': self.link_metas('acme-3f2a9c1b-link'), 'run_id': []},
            'proxy_name': 'acme', 'proxy_type': 'http', 'subdomain': 'acme'})
        self.assertEqual(answer, {'reject': True,
                                  'reject_reason': 'this run id belongs to another client'})
        row_after = self.route_row()
        self.assertEqual(row_after[0], row_before[0], 'the malformed NewProxy moved the generation')
        self.assertEqual(row_after[1], row_before[1], 'the malformed NewProxy moved the route client')
        self.assertEqual(row_after[2], 'pending', 'a route read straightened the row before validation')
        self.assertEqual(row_after[3], row_before[3], 'the malformed NewProxy moved the run id')

    def test_newproxy_empty_run_id_registers(self) -> None:
        # I6 keeps the legacy wire working: the empty run id a real frps sends
        # registers normally.
        answer = self.plugin_post('NewProxy', {
            'user': {'user': '', 'metas': self.link_metas('acme-3f2a9c1b-link'), 'run_id': ''},
            'proxy_name': 'acme', 'proxy_type': 'http', 'subdomain': 'acme'})
        self.assertEqual(answer, {'reject': False, 'unchange': True})
        status, route = self.stack.api('GET', '/api/v1/links/acme/route', key=self.key)
        self.assertEqual(status, 200, route)
        self.assertEqual(route['generation'], 1)

    def test_r5_1_peer_services(self) -> None:
        status, body = self.visitor_key()
        # I8: fixed message; the body carries the generated visitor key.
        self.assertEqual(status, 200, 'issuing a visitor key must answer 200')
        visitor_key = body['visitorKey']
        sk_data, sk_app = secrets.token_hex(20), secrets.token_hex(20)
        # The two services answer from two different named servers, so the test
        # proves exactly which service each visitor reached (I2: both targets
        # wired to one server must fail here).
        data_port = self.extra_echo('acme-data')
        app_target = self.extra_echo('acme-app')
        peer = self.stack.client('acme', self.key, settings='network', client=PEER,
                                 proxies=self.stcp_proxies((f'acme-{M8}-data', sk_data, data_port),
                                                           (f'acme-{M8}-app', sk_app,
                                                            app_target)))
        self.assertTrue(peer.started(f'acme-{M8}-data'), peer.log())
        self.assertTrue(peer.started(f'acme-{M8}-app'), peer.log())
        app_port = self.stack._free_port()
        visitor = self.stack.client('acme', None, settings='network', client=VISITOR,
                                    visitor_key=visitor_key,
                                    proxies=self.visitor_proxy(f'acme-{M8}-app', sk_app, app_port))
        self.assertTrue(_wait(lambda: 'start visitor success' in visitor.log(), 15), visitor.log())
        answer = json.loads(self.echo(app_port))
        self.assertEqual(answer, {'service': 'acme-app', 'path': '/through-the-relay'})
        data_bind = self.stack._free_port()
        data_visitor = self.stack.client('acme', None, settings='network', client='acme-77aa0013-visit',
                                         visitor_key=visitor_key,
                                         proxies=self.visitor_proxy(f'acme-{M8}-data', sk_data, data_bind))
        self.assertTrue(_wait(lambda: 'start visitor success' in data_visitor.log(), 15),
                        data_visitor.log())
        identity = self.echo(data_bind, '/data-check')
        self.assertEqual(json.loads(identity), {'service': 'acme-data', 'path': '/data-check'})
        # stcp services get no route row and no generation: the name reads empty at 0.
        status, route = self.stack.api('GET', '/api/v1/links/acme/route', key=self.key)
        self.assertEqual(status, 200, route)
        self.assertEqual(route['state'], 'empty')
        self.assertEqual(route['generation'], 0)
        self.assertIsNone(route['client'])
        with sqlite3.connect(f"file:{self.stack.env['RELAY_DB']}?mode=ro", uri=True) as conn:
            rows = conn.execute('SELECT COUNT(*) FROM routes WHERE name = ?', ('acme',)).fetchone()
        self.assertEqual(rows[0], 0)
        bad_port = self.stack._free_port()
        bad = self.stack.client('acme', None, settings='network', client='acme-77aa0012-visit',
                                visitor_key=visitor_key,
                                proxies=self.visitor_proxy(f'acme-{M8}-app', secrets.token_hex(20),
                                                           bad_port))
        self.assertTrue(_wait(lambda: 'start visitor success' in bad.log(), 15), bad.log())
        self.echo_closes_silent(bad_port)

    def test_r5_1_stcp_registration_keeps_the_link_route(self) -> None:
        # I1: registering peer services moves no generation and leaves a held link route's
        # client, since and generation exactly as they were.
        link = self.stack.client('acme', self.key, settings='network', client='acme-3f2a9c1b-link')
        self.assertTrue(link.started('acme'), link.log())
        status, before = self.stack.api('GET', '/api/v1/links/acme/route', key=self.key)
        self.assertEqual(status, 200, before)
        self.assertEqual(before['state'], 'held')
        sk = secrets.token_hex(20)
        peer = self.stack.client('acme', self.key, settings='network', client=PEER,
                                 proxies=self.stcp_proxies((f'acme-{M8}-data', sk, self.stack.echo_port)))
        self.assertTrue(peer.started(f'acme-{M8}-data'), peer.log())
        status, after = self.stack.api('GET', '/api/v1/links/acme/route', key=self.key)
        self.assertEqual(status, 200, after)
        self.assertEqual(after['state'], 'held')
        self.assertEqual(after['client'], before['client'])
        self.assertEqual(after['since'], before['since'])
        self.assertEqual(after['generation'], before['generation'])

    def test_r5_1_peer_limits(self) -> None:
        status, body = self.visitor_key()
        # I8: fixed message; the body carries the generated visitor key.
        self.assertEqual(status, 200, 'issuing a visitor key must answer 200')
        visitor_key = body['visitorKey']
        sk = secrets.token_hex(20)
        cases = (
            # An stcp name with another machine's id.
            (f'acme-ffffffff-data', 'stcp', {'sk': sk}),
            # No http proxy from a peer.
            ('acme', 'http', {'subdomain': 'acme'}),
            # The secret must be at least 32 characters.
            (f'acme-{M8}-data', 'stcp', {'sk': 'shortkey'}),
            # allow_users is empty or ["*"] only.
            (f'acme-{M8}-data', 'stcp', {'sk': sk, 'allow_users': ['someone']}),
            # A name outside data and app.
            (f'acme-{M8}-other', 'stcp', {'sk': sk}),
        )
        for proxy_name, proxy_type, extra in cases:
            with self.subTest(proxy_name=proxy_name):
                answer = self.newproxy(self.link_metas(PEER), proxy_name, proxy_type, **extra)
                self.assertEqual(answer, {'reject': True,
                                          'reject_reason': f'this client may not offer {proxy_name}'})
        # The second service name is fine, so the refusals above are not a broken client id.
        allowed = self.newproxy(self.link_metas(PEER), f'acme-{M8}-data', 'stcp', sk=sk,
                                allow_users=['*'])
        self.assertEqual(allowed, {'reject': False, 'unchange': True})
        # A link client offers no stcp proxy; a visitor-key session offers nothing at all.
        link = self.newproxy(self.link_metas('acme-3f2a9c1b-link'), f'acme-{M8}-data', 'stcp', sk=sk)
        self.assertEqual(link, {'reject': True, 'reject_reason': 'only http proxies are allowed'})
        visiting = self.newproxy({'name': 'acme', 'visitor': visitor_key, 'client': VISITOR},
                                 f'acme-{M8}-data', 'stcp', sk=sk)
        self.assertEqual(visiting, {'reject': True,
                                    'reject_reason': 'visitors may not offer services'})
        # A visitor-key session offers no http proxy either.
        visiting_http = self.newproxy({'name': 'acme', 'visitor': visitor_key, 'client': VISITOR},
                                      'acme', 'http', subdomain='acme')
        self.assertEqual(visiting_http, {'reject': True,
                                         'reject_reason': 'visitors may not offer services'})
        # R6.2: a new visitor key replaces the one before.
        status, second = self.visitor_key()
        # I8: fixed messages; both values carry the generated visitor keys.
        self.assertEqual(status, 200, 'rotating the visitor key must answer 200')
        self.assertTrue(second['visitorKey'] != visitor_key,
                        'a new visitor key must replace the one before')
        outdated = self.login({'name': 'acme', 'visitor': visitor_key, 'client': VISITOR}, VISITOR)
        self.assertEqual(outdated, {'reject': True, 'reject_reason': 'no binding acme with this key'})
        current = self.login({'name': 'acme', 'visitor': second['visitorKey'], 'client': VISITOR},
                             VISITOR)
        self.assertEqual(current, {'reject': False, 'unchange': True})

    def test_r6_2_visitor_key_needs_the_link_key(self) -> None:
        status, body = self.visitor_key()
        # I8: fixed message; the body carries the generated visitor key.
        self.assertEqual(status, 200, 'issuing a visitor key must answer 200')
        visitor_key = body['visitorKey']
        # No Authorization at all, or the visitor key in place of the link key: 401.
        status, _body = self.stack.api('POST', '/api/v1/links/acme/visitor-key')
        self.assertEqual(status, 401, 'issuing a visitor key without the link key must answer 401')
        status, _body = self.stack.api('POST', '/api/v1/links/acme/visitor-key', key=visitor_key)
        self.assertEqual(status, 401, 'the visitor key must not authorize visitor-key issuance')

    def test_r6_2_visitor_key_busy_keeps_the_old_hash(self) -> None:
        # I7: a visitor-key write that cannot take the store's lock in its budget answers
        # 503 busy with Retry-After and leaves the stored hash exactly as it was.
        status, body = self.visitor_key()
        # I8: fixed message; the body carries the generated visitor key.
        self.assertEqual(status, 200, 'issuing a visitor key must answer 200')
        old_hash = self.visitor_key_hash()
        db = sqlite3.connect(str(Path(self.tmp) / 'relay.db'), timeout=10, isolation_level=None)
        self.addCleanup(db.close)
        db.execute('BEGIN IMMEDIATE')
        db.execute("INSERT INTO creations (ip, at) VALUES ('holding the write lock', 0)")
        try:
            connection = http.client.HTTPConnection('127.0.0.1', self.stack.relay_port, timeout=5)
            connection.request('POST', '/api/v1/links/acme/visitor-key',
                               headers={'Authorization': f'Bearer {self.key}'})
            response = connection.getresponse()
            self.assertEqual(response.status, 503)
            self.assertEqual(response.getheader('Retry-After'), '1')
            answer = json.loads(response.read())
            self.assertEqual(answer['error'], 'busy')
            connection.close()
        finally:
            db.execute('ROLLBACK')
        # I8: boolean form, so a plaintext store regression renders no credential.
        self.assertTrue(self.visitor_key_hash() == old_hash,
                        'a busy visitor-key write changed the stored hash')

    def visitor_key_hash(self) -> str | None:
        with sqlite3.connect(f"file:{self.stack.env['RELAY_DB']}?mode=ro", uri=True) as conn:
            row = conn.execute('SELECT key_hash FROM visitor_keys WHERE name = ?', ('acme',)).fetchone()
        return row[0] if row else None

    def test_r6_2_visitor_key_dies_with_the_binding_api(self) -> None:
        # C2: releasing a binding invalidates its visitor key, so a visitor key from before
        # DELETE /bindings/<name> cannot log in after the name is bound again.
        status, body = self.visitor_key()
        # I8: fixed message; the body carries the generated visitor key.
        self.assertEqual(status, 200, 'issuing a visitor key must answer 200')
        old_visitor_key = body['visitorKey']
        status, _ = self.stack.api('DELETE', '/api/v1/bindings/acme', key=self.key)
        self.assertEqual(status, 204)
        observed = self.visitor_key_hash()
        self.assertTrue(observed is None, 'API release left a stored visitor credential')
        rebound = self.stack.bind('acme')
        self.assertTrue(rebound['key'] != self.key,
                        'a rebind must hand out a new binding key')
        stale = self.login({'name': 'acme', 'visitor': old_visitor_key, 'client': VISITOR}, VISITOR)
        self.assertEqual(stale, {'reject': True, 'reject_reason': 'no binding acme with this key'})
        status, body = self.stack.api('POST', '/api/v1/links/acme/visitor-key', key=rebound['key'])
        # I8: fixed message; the body carries the generated visitor key.
        self.assertEqual(status, 200, 'issuing a visitor key for the new owner must answer 200')
        current = self.login({'name': 'acme', 'visitor': body['visitorKey'], 'client': VISITOR}, VISITOR)
        self.assertEqual(current, {'reject': False, 'unchange': True})

    def test_r6_2_visitor_key_dies_with_the_binding_admin(self) -> None:
        # C2: the operator paths keep visitor credentials inside the binding lifetime too.
        status, body = self.visitor_key()
        # I8: fixed message; the body carries the generated visitor key.
        self.assertEqual(status, 200, 'issuing a visitor key must answer 200')
        old_visitor_key = body['visitorKey']
        env = dict(self.stack.env)
        released = subprocess.run(
            [sys.executable, str(ROOT / 'relay/relay.py'), 'admin', 'release', 'acme'],
            env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(released.returncode, 0, released.stderr)
        observed = self.visitor_key_hash()
        self.assertTrue(observed is None, 'admin release left a stored visitor credential')
        added = subprocess.run(
            [sys.executable, str(ROOT / 'relay/relay.py'), 'admin', 'add', 'acme'],
            env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(added.returncode, 0, added.stderr)
        recreated = json.loads(added.stdout)
        self.assertEqual(recreated['name'], 'acme')
        stale = self.login({'name': 'acme', 'visitor': old_visitor_key, 'client': VISITOR}, VISITOR)
        self.assertEqual(stale, {'reject': True, 'reject_reason': 'no binding acme with this key'})

    def test_r6_2_visitor_key(self) -> None:
        status, body = self.visitor_key()
        # I8: fixed message; the body carries the generated visitor key.
        self.assertEqual(status, 200, 'issuing a visitor key must answer 200')
        visitor_key = body['visitorKey']
        decoded = base64.urlsafe_b64decode(visitor_key + '=' * (-len(visitor_key) % 4))
        self.assertEqual(len(decoded), 32)
        stored = self.visitor_key_hash()
        # I8: boolean assertions with fixed messages, so an unsafe store is
        # detected without ever rendering the generated key in diagnostics.
        self.assertTrue(stored == hashlib.sha256(visitor_key.encode()).hexdigest(),
                        'the stored visitor hash does not match the issued key')
        self.assertTrue(visitor_key not in stored,
                        'the stored visitor hash contains the visitor key itself')
        status, _body = self.visitor_key(key='wrong')
        self.assertEqual(status, 401, 'issuing a visitor key with a wrong link key must answer 401')
        status, _body = self.visitor_key(name='nope')
        self.assertEqual(status, 404, 'issuing a visitor key for an unknown name must answer 404')
        # Rotation through the API replaces the stored hash.
        status, body = self.visitor_key()
        # I8: fixed message; the body carries the generated visitor key.
        self.assertEqual(status, 200, 'issuing a visitor key must answer 200')
        self.assertTrue(self.visitor_key_hash() == hashlib.sha256(body['visitorKey'].encode()).hexdigest(),
                        'the rotated visitor hash does not match the new key')


class VisitorKeyDiagnosticTests(unittest.TestCase):
    """Unsafe plaintext observations still fail without rendering the issued key."""

    def check_lifecycle_diagnostic(self, method: str) -> None:
        case = PeerTests(method)
        issued = []
        original = case.visitor_key

        def issue_key() -> tuple[int, dict | None]:
            status, body = original()
            if status == 200:
                issued.append(body['visitorKey'])
            return status, body

        case.visitor_key = issue_key
        case.visitor_key_hash = lambda: issued[0]
        result = unittest.TestResult()
        case.run(result)
        self.assertEqual(result.testsRun, 1)
        self.assertEqual(len(result.failures), 1, 'the plaintext observation must still be detected')
        self.assertEqual(len(result.errors), 0, 'the injected observation must not cause an error')
        self.assertTrue(bool(issued), 'the lifecycle test must issue a visitor key')
        diagnostic = result.failures[0][1]
        self.assertTrue(all(key not in diagnostic for key in issued),
                        'the captured lifecycle failure rendered a visitor key')

    def test_api_release_diagnostic_hides_visitor_key(self) -> None:
        self.check_lifecycle_diagnostic('test_r6_2_visitor_key_dies_with_the_binding_api')

    def test_admin_release_diagnostic_hides_visitor_key(self) -> None:
        self.check_lifecycle_diagnostic('test_r6_2_visitor_key_dies_with_the_binding_admin')


# frp 0.71.1 v1 wire constants, pinned against the local binaries under test:
# a control login is one yamux stream (12-byte header, version 0; only data
# frames carry a payload, the length field of windowUpdate/ping frames is a
# value) with one msg.Login on it: 1 type byte ('o'), 8 big-endian length
# bytes, a JSON body whose metas map rides as "metas"; token auth is
# privilege_key = md5(token + decimal timestamp), the test frps.toml pinning an
# empty token. The answer is one msg.LoginResp ('1'): the run id, or an error.
_Y_DATA, _Y_WINDOW, _Y_PING, _Y_GOAWAY = 0, 1, 2, 3
_Y_SYN, _Y_ACK = 0x1, 0x2
_MSG_LOGIN_RESP = b'1'


class FrpsWireSession:
    """One native frps control login, spoken by hand over the v1 wire (R1.3).

    A plugin post cannot displace a real session, so takeover tests log in
    through frps itself. The reader answers the server's keepalive pings
    (a ping with the SYN flag, its id in the length field) with a ping
    carrying the ACK flag and the same id, as the bundled yamux fork does.
    """

    def __init__(self, stack, metas: dict, client_id: str = '', run_id: str = ''):
        self.sock = socket.create_connection(('127.0.0.1', stack.bind_port), timeout=15)
        self.send_lock = threading.Lock()
        self.incoming = bytearray()
        self.closed = threading.Event()
        self.reader = threading.Thread(target=self._read_frames, daemon=True)
        self.reader.start()
        timestamp = int(time.time())
        login = {'version': '0.71.1', 'hostname': 'native-probe',
                 'privilege_key': hashlib.md5(str(timestamp).encode()).hexdigest(),
                 'timestamp': timestamp, 'metas': metas, 'pool_count': 0}
        if client_id:
            login['client_id'] = client_id
        if run_id:
            login['run_id'] = run_id
        body = json.dumps(login).encode()
        with self.send_lock:
            self.sock.sendall(struct.pack('>BBHII', 0, _Y_WINDOW, _Y_SYN, 1, 0)
                              + struct.pack('>BBHII', 0, _Y_DATA, 0, 1, 9 + len(body))
                              + b'o' + struct.pack('>q', len(body)) + body)
        self.resp = self._wait_login_resp()

    def _send(self, ftype: int, flags: int, stream: int, value: int, payload: bytes = b'') -> None:
        with self.send_lock:
            self.sock.sendall(struct.pack('>BBHII', 0, ftype, flags, stream, value) + payload)

    def _read_frames(self) -> None:
        try:
            while True:
                header = self._exact(12)
                if header is None:
                    break
                _, ftype, flags, stream, value = struct.unpack('>BBHII', header)
                if ftype == _Y_DATA:
                    payload = self._exact(value) if value else b''
                    if payload is None:
                        break
                    if stream == 1:
                        self.incoming += payload
                elif ftype == _Y_PING and flags & _Y_SYN:
                    self._send(_Y_PING, _Y_ACK, 0, value)
                elif ftype == _Y_GOAWAY:
                    break
        except OSError:
            pass
        finally:
            self.closed.set()

    def _exact(self, size: int):
        data = b''
        while len(data) < size:
            chunk = self.sock.recv(size - len(data))
            if not chunk:
                return None
            data += chunk
        return data

    def _wait_login_resp(self, within: float = 15):
        deadline = time.monotonic() + within
        while time.monotonic() < deadline:
            if len(self.incoming) >= 9:
                length = struct.unpack('>q', bytes(self.incoming[1:9]))[0]
                if len(self.incoming) >= 9 + length:
                    if self.incoming[0:1] != _MSG_LOGIN_RESP:
                        return None
                    return json.loads(bytes(self.incoming[9:9 + length]))
            if self.closed.is_set():
                return None
            time.sleep(0.02)
        raise TimeoutError('frps did not answer the native Login')

    @property
    def accepted(self) -> bool:
        return self.resp is not None and not self.resp.get('error')

    def close(self) -> None:
        # On Linux close() sends nothing while the reader thread blocks in recv(); shutdown() tells frps at once.
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()


class NativeLoginTakeoverTests(unittest.TestCase):
    """R1.3, C1 on the real frps wire: a refused run-id takeover leaves the
    victim session online and its company traffic serving."""

    def setUp(self) -> None:
        self.tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-wire-'))
        self.stack = self.enterContext(Stack(self.tmp))
        self.acme = self.stack.bind('acme')

    def wire_login(self, metas: dict, client_id: str = '', run_id: str = '') -> FrpsWireSession:
        session = FrpsWireSession(self.stack, metas, client_id, run_id)
        self.addCleanup(session.close)
        return session

    def link_metas(self, client: str) -> dict:
        return {'name': 'acme', 'key': self.acme['key'], 'client': client}

    def recorded_run_id(self, name: str) -> str | None:
        with sqlite3.connect(f"file:{self.stack.env['RELAY_DB']}?mode=ro", uri=True) as conn:
            row = conn.execute('SELECT run_id FROM routes WHERE name = ?', (name,)).fetchone()
        return row[0] if row else None

    def online_sessions(self) -> list:
        status, clients = self.stack.dash('/api/clients')
        self.assertEqual(status, 200)
        return clients

    def session_online(self, run_id: str) -> bool:
        return any(c['online'] and c['runID'] == run_id for c in self.online_sessions())

    def unrecorded_legacy_sessions(self) -> list:
        # Live legacy sessions (dashboard clientID is the run id itself) whose
        # run id no routes row records: a refused NewProxy leaves one online.
        recorded = {self.recorded_run_id('acme'), self.recorded_run_id('globex')}
        return [c for c in self.online_sessions()
                if c['online'] and c['clientID'] == c['runID'] and c['runID'] not in recorded]

    def test_wire_login_positive_control(self) -> None:
        # The helper speaks the real wire: a fresh legacy login is accepted and
        # shown online. Every refusal assertion below relies on this acceptance
        # path working end to end. (Reconnecting an unrecorded legacy run id is
        # refused by design: the accepted cost is an eviction wait and frpc's
        # retry with a fresh run id; see test_wire_legacy_reconnect_with_proven_route_kept
        # for the reconnect that stays.)
        session = self.wire_login({'name': 'acme', 'key': self.acme['key']})
        self.assertTrue(session.accepted, session.resp)
        self.assertTrue(self.session_online(session.resp['run_id']), self.online_sessions())

    def test_wire_legacy_reserved_identity_absent_refused(self) -> None:
        globex = self.stack.bind('globex')
        reserved_id = f'globex-{M8}-link'
        status, entries = self.stack.dash(f'/api/clients?runId={reserved_id}')
        self.assertEqual(status, 200)
        self.assertEqual(len(entries), 0)
        legacy = self.wire_login({'name': 'acme', 'key': self.acme['key']}, run_id=reserved_id)
        self.assertFalse(legacy.accepted, 'a legacy login reserved an absent network identity')
        self.assertFalse(any(c['online'] and c['clientID'] == reserved_id for c in self.online_sessions()),
                         'the refused legacy identity was registered online')
        legitimate = self.stack.client('globex', globex['key'], settings='network', client=reserved_id)
        self.assertTrue(legitimate.started('globex'), 'the legitimate client could not start afterward')
        self.assertEqual(self.stack.get('globex.hornhoof.org'), 200)

    def test_wire_legacy_reserved_identity_offline_refused(self) -> None:
        globex = self.stack.bind('globex')
        reserved_id = f'globex-{M8}-link'
        prior = self.wire_login({'name': 'globex', 'key': globex['key'], 'client': reserved_id},
                                client_id=reserved_id, run_id=reserved_id)
        self.assertTrue(prior.accepted, 'the explicit-ID offline control must first log in')
        prior.close()
        self.assertTrue(_wait(lambda: not self.session_online(reserved_id), 5))
        entries = [c for c in self.online_sessions() if c['clientID'] == reserved_id]
        self.assertEqual(len(entries), 1)
        self.assertIs(entries[0]['online'], False)
        legacy = self.wire_login({'name': 'acme', 'key': self.acme['key']}, run_id=reserved_id)
        self.assertFalse(legacy.accepted, 'a legacy login reserved an offline network identity')
        self.assertFalse(any(c['online'] and c['clientID'] == reserved_id for c in self.online_sessions()),
                         'the refused legacy identity was registered online')
        legitimate = self.stack.client('globex', globex['key'], settings='network', client=reserved_id)
        self.assertTrue(legitimate.started('globex'), 'the legitimate client could not start afterward')
        self.assertEqual(self.stack.get('globex.hornhoof.org'), 200)

    def test_wire_genuine_legacy_reconnect_after_disconnect_kept(self) -> None:
        run_id = '0123456789abcdef'
        status, entries = self.stack.dash(f'/api/clients?runId={run_id}')
        self.assertEqual(status, 200)
        self.assertEqual(len(entries), 0)
        session = self.wire_login({'name': 'acme', 'key': self.acme['key']}, run_id=run_id)
        self.assertTrue(session.accepted, 'a genuine absent legacy run id must still log in')
        self.assertTrue(self.session_online(run_id))
        session.close()
        self.assertTrue(_wait(lambda: not self.session_online(run_id), 5))
        reconnect = self.wire_login({'name': 'acme', 'key': self.acme['key']}, run_id=run_id)
        self.assertTrue(reconnect.accepted, 'a genuine offline legacy run id must still reconnect')
        self.assertTrue(self.session_online(run_id))

    def test_wire_foreign_takeover_of_recorded_legacy_refused(self) -> None:
        globex = self.stack.bind('globex')
        victim = self.stack.client('globex', globex['key'])
        self.assertTrue(victim.started('globex'), victim.log())
        run_id = self.recorded_run_id('globex')
        self.assertTrue(run_id)
        attack = self.wire_login({'name': 'acme', 'key': self.acme['key']}, run_id=run_id)
        self.assertFalse(attack.accepted, attack.resp)
        self.assertTrue(self.session_online(run_id), self.online_sessions())
        self.assertEqual(self.stack.get('globex.hornhoof.org'), 200)

    def test_wire_foreign_takeover_of_unrecorded_legacy_refused(self) -> None:
        globex = self.stack.bind('globex')
        first = self.stack.client('globex', globex['key'])
        self.assertTrue(first.started('globex'), first.log())
        second = self.stack.client('globex', globex['key'])
        self.assertTrue(_wait(lambda: 'router config conflict' in second.log(), 15), second.log())
        victims = self.unrecorded_legacy_sessions()
        self.assertEqual(len(victims), 1, self.online_sessions())
        run_id = victims[0]['runID']
        attack = self.wire_login({'name': 'acme', 'key': self.acme['key']}, run_id=run_id)
        self.assertFalse(attack.accepted, attack.resp)
        self.assertTrue(self.session_online(run_id), self.online_sessions())
        self.assertEqual(self.stack.get('globex.hornhoof.org'), 200)

    def test_wire_legacy_reconnect_with_proven_route_kept(self) -> None:
        # The positive reconnect control on the wire: the binding's own legacy
        # run id, recorded in the routes ledger, still takes its session over.
        globex = self.stack.bind('globex')
        holder = self.stack.client('globex', globex['key'])
        self.assertTrue(holder.started('globex'), holder.log())
        run_id = self.recorded_run_id('globex')
        reconnect = self.wire_login({'name': 'globex', 'key': globex['key']}, run_id=run_id)
        self.assertTrue(reconnect.accepted, reconnect.resp)
        self.assertEqual(reconnect.resp['run_id'], run_id)
        self.assertTrue(self.session_online(run_id), self.online_sessions())

    def test_wire_peer_run_id_equal_client_id_kept(self) -> None:
        # An explicit-ID session whose run id equals its client id is its own:
        # a fresh login with that pair is accepted.
        peer_id = f'acme-{M8}-peer'
        session = self.wire_login(self.link_metas(peer_id), client_id=peer_id, run_id=peer_id)
        self.assertTrue(session.accepted, session.resp)
        self.assertTrue(self.session_online(peer_id), self.online_sessions())

    def test_wire_legacy_login_matching_peer_run_id_refused(self) -> None:
        # C1: a legacy login (no client id) presenting the live run id of an
        # explicit-ID peer session (run id == client id, no routes row) used to
        # be accepted and displaced the peer; the id fullmatches CLIENT, so it
        # is not legacy ownership. The victim session must stay online.
        peer_id = f'acme-{M8}-peer'
        peer = self.wire_login(self.link_metas(peer_id), client_id=peer_id, run_id=peer_id)
        self.assertTrue(peer.accepted, peer.resp)
        attack = self.wire_login({'name': 'acme', 'key': self.acme['key']}, run_id=peer_id)
        self.assertFalse(attack.accepted, attack.resp)
        self.assertTrue(self.session_online(peer_id), self.online_sessions())


class _DelayedDashboard(BaseHTTPRequestHandler):
    def do_GET(self):
        with self.server.lock:
            self.server.paths.append(self.path)
        status, body, delay = self.server.records.get(self.path, (404, b'{}', 0.0))
        if delay:
            time.sleep(delay)
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


class LoginReadBudgetTests(unittest.TestCase):
    """The Login run-id dashboard read on the plugin call's 1 s budget (in-process relay)."""

    CLIENT_ID = 'acme-3f2a9c1b-link'

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), _DelayedDashboard)
        cls.server.daemon_threads = True
        cls.server.records = {}
        cls.server.paths = []
        cls.server.lock = threading.Lock()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def setUp(self) -> None:
        self.tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-login-read-'))
        self.relay = _relay_module()
        self.relay.DB_PATH = str(Path(self.tmp) / 'relay.db')
        self.relay.RELAY_FRPS_API = f'http://127.0.0.1:{self.server.server_port}'
        self.relay.init_db()
        conn = self.relay.db()
        conn.execute('INSERT INTO bindings (name, key_hash, created_at, created_ip) VALUES (?, ?, ?, ?)',
                     ('acme', self.relay.key_hash('k'), self.relay.now(), 'test'))
        with self.server.lock:
            self.server.records.clear()
            self.base_paths = len(self.server.paths)

    def login_with_run_id(self, run_id: str) -> dict:
        return self.relay.plugin('Login', {
            'metas': {'name': 'acme', 'key': 'k', 'client': self.CLIENT_ID},
            'client_id': self.CLIENT_ID, 'run_id': run_id})

    def record(self, answer: list, delay: float) -> None:
        self.server.records[f'/api/clients?runId=r9'] = (
            200, json.dumps(answer).encode(), delay)

    def requested_paths(self) -> list:
        with self.server.lock:
            return self.server.paths[self.base_paths:]

    def test_legacy_run_id_namespace_with_absent_and_offline_answers(self) -> None:
        # Real frps clears an offline record's runID, so its filtered answer is
        # absent. Pin an explicit offline answer at the same plugin boundary too.
        cases = (('network', f'globex-{M8}-link',
                  {'reject': True, 'reject_reason': 'this run id belongs to another client'}),
                 ('legacy', '0123456789abcdef', {'reject': False, 'unchange': True}))
        for namespace, run_id, expected in cases:
            for state, entries in (('absent', []), ('offline', [{'clientID': run_id, 'online': False}])):
                with self.subTest(namespace=namespace, state=state):
                    self.server.records[f'/api/clients?runId={run_id}'] = (
                        200, json.dumps(entries).encode(), 0.0)
                    result = self.relay.plugin('Login', {
                        'metas': {'name': 'acme', 'key': 'k'}, 'run_id': run_id})
                    self.assertEqual(result, expected)

    def test_login_run_id_read_is_filtered_and_fast_good_answer_passes(self) -> None:
        self.record([{'clientID': self.CLIENT_ID, 'online': True}], 0.0)
        result = self.login_with_run_id('r9')
        self.assertEqual(result, {'reject': False, 'unchange': True})
        self.assertEqual(self.requested_paths(), ['/api/clients?runId=r9'])

    def test_login_run_id_read_refuses_a_slow_answer_within_the_budget(self) -> None:
        # LEAD RULING: the per-plugin-read cap stays min(0.5 s, time left). A 0.7 s good
        # answer is refused within the shared 1 s budget, not waited out.
        self.record([{'clientID': self.CLIENT_ID, 'online': True}], 0.7)
        started = time.monotonic()
        result = self.login_with_run_id('r9')
        elapsed = time.monotonic() - started
        self.assertEqual(result, {'reject': True,
                                  'reject_reason': 'relay error: frps does not answer'})
        self.assertLess(elapsed, 1.0, f'a 0.7 s read was refused only after {elapsed:.2f} s')

    def test_login_run_id_read_refuses_a_hang_within_the_budget(self) -> None:
        self.record([{'clientID': self.CLIENT_ID, 'online': True}], 3.0)
        started = time.monotonic()
        result = self.login_with_run_id('r9')
        elapsed = time.monotonic() - started
        self.assertEqual(result, {'reject': True,
                                  'reject_reason': 'relay error: frps does not answer'})
        self.assertLess(elapsed, 1.0, f'a hanging read was refused only after {elapsed:.2f} s')

    def test_login_run_id_read_with_a_spent_budget_never_reaches_the_dashboard(self) -> None:
        old = self.relay.PLUGIN_CALL_S
        self.addCleanup(setattr, self.relay, 'PLUGIN_CALL_S', old)
        self.relay.PLUGIN_CALL_S = 0.0  # the call's budget is spent the moment it starts
        self.record([{'clientID': self.CLIENT_ID, 'online': True}], 0.0)
        result = self.login_with_run_id('r9')
        self.assertEqual(result, {'reject': True,
                                  'reject_reason': 'relay error: frps does not answer'})
        self.assertEqual(self.requested_paths(), [])


class VisitorKeyStoreTests(unittest.TestCase):
    """The visitor-key store against an in-process relay and its own SQLite file."""

    def setUp(self) -> None:
        self.tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-vkey-'))
        self.relay = _relay_module()
        self.relay.DB_PATH = str(Path(self.tmp) / 'relay.db')
        self.relay.init_db()
        self.conn = self.relay.db()

    def bind(self, name: str, key: str) -> None:
        self.conn.execute('INSERT INTO bindings (name, key_hash, created_at, created_ip) VALUES (?, ?, ?, ?)',
                          (name, self.relay.key_hash(key), self.relay.now(), 'test'))

    def stored_hash(self, name: str = 'acme'):
        return self.conn.execute('SELECT key_hash FROM visitor_keys WHERE name = ?', (name,)).fetchone()

    def test_store_and_release_are_atomic_with_the_binding(self) -> None:
        self.bind('acme', 'k1')
        self.assertTrue(self.relay.store_visitor_key('acme', self.relay.key_hash('v1'),
                                                     self.relay.key_hash('k1')))
        self.assertTrue(self.stored_hash()[0] == self.relay.key_hash('v1'),
                        'the stored visitor hash does not match the issued key')
        self.relay.release_binding('acme')
        self.assertIsNone(self.stored_hash())
        self.assertIsNone(self.conn.execute('SELECT 1 FROM bindings WHERE name = ?', ('acme',)).fetchone())

    def test_stale_authorization_cannot_store_after_release_and_rebind(self) -> None:
        # C2: a request authorized against the old binding must not be able to store a
        # credential for the new binding after the name was released and bound again.
        self.bind('acme', 'k1')
        self.assertTrue(self.relay.store_visitor_key('acme', self.relay.key_hash('v1'),
                                                     self.relay.key_hash('k1')))
        self.relay.release_binding('acme')
        self.bind('acme', 'k2')
        self.assertFalse(self.relay.store_visitor_key('acme', self.relay.key_hash('v2'),
                                                      self.relay.key_hash('k1')))
        self.assertIsNone(self.stored_hash())
        # the current binding's own authorization stores, and a stale one cannot replace it
        self.assertTrue(self.relay.store_visitor_key('acme', self.relay.key_hash('v2'),
                                                     self.relay.key_hash('k2')))
        self.assertFalse(self.relay.store_visitor_key('acme', self.relay.key_hash('v3'),
                                                      self.relay.key_hash('k1')))
        self.assertTrue(self.stored_hash()[0] == self.relay.key_hash('v2'),
                        'the stored visitor hash does not match the issued key')


class VisitorKeyLifecycleTests(unittest.TestCase):
    """C2: the binding's credential lifecycle under races, faults and operator
    action, against an in-process relay and its own SQLite file."""

    def setUp(self) -> None:
        self.tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-lifecycle-'))
        self.relay = _relay_module()
        self.relay.DB_PATH = str(Path(self.tmp) / 'relay.db')
        self.relay.init_db()

    def bind(self, name: str, key: str) -> None:
        self.relay.db().execute(
            'INSERT INTO bindings (name, key_hash, created_at, created_ip) VALUES (?, ?, ?, ?)',
            (name, self.relay.key_hash(key), self.relay.now(), 'test'))

    def binding_row(self, name: str = 'acme'):
        return self.relay.db().execute(
            'SELECT key_hash, banned_at FROM bindings WHERE name = ?', (name,)).fetchone()

    def stored_hash(self, name: str = 'acme') -> str | None:
        row = self.relay.db().execute(
            'SELECT key_hash FROM visitor_keys WHERE name = ?', (name,)).fetchone()
        return row[0] if row else None

    def start_server(self) -> tuple:
        server = ThreadingHTTPServer(('127.0.0.1', 0), self.relay.Handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server, server.server_port

    def api(self, port: int, method: str, path: str, key: str | None = None,
            body: dict | None = None) -> tuple:
        headers = {}
        if key is not None:
            headers['Authorization'] = f'Bearer {key}'
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers['Content-Type'] = 'application/json'
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
        try:
            connection.request(method, path, data, headers)
            response = connection.getresponse()
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
        finally:
            connection.close()

    def admin(self, *args: str) -> str:
        env = dict(os.environ, RELAY_DB=self.relay.DB_PATH)
        result = subprocess.run(
            [sys.executable, str(ROOT / 'relay/relay.py'), 'admin', *args],
            env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def pause_release_once(self, relay) -> tuple:
        """Hook release_binding to pause the first call after authorization;
        returns (entered, resume, restore)."""
        entered, resume = threading.Event(), threading.Event()
        original = relay.release_binding
        pause_first = [True]

        def paused_release(name, *args, **kwargs):
            if pause_first[0]:
                pause_first[0] = False
                entered.set()
                if not resume.wait(10):
                    raise TimeoutError('release was not resumed')
            return original(name, *args, **kwargs)
        relay.release_binding = paused_release
        return entered, resume, (lambda: setattr(relay, 'release_binding', original))

    def test_concurrent_issuer_cannot_plant_credential_during_release(self) -> None:
        # C2: release paused between its two deletes; an issuer authorized
        # against the still-existing binding must not plant a credential. Under
        # the release transaction its write waits for the lock and refuses;
        # without the transaction the orphan row lands and this test fails.
        relay = self.relay
        self.bind('acme', 'k1')
        self.assertTrue(relay.store_visitor_key('acme', relay.key_hash('v1'), relay.key_hash('k1')))
        entered, resume, issuer_done = threading.Event(), threading.Event(), threading.Event()
        issuer_result = []
        original_write = relay.write

        def hooked_write(sql, args):
            original_write(sql, args)
            if sql.startswith('DELETE FROM visitor_keys'):
                entered.set()
                if not resume.wait(10):
                    raise TimeoutError('release was not resumed')
        relay.write = hooked_write
        self.addCleanup(setattr, relay, 'write', original_write)
        releaser = threading.Thread(target=relay.release_binding, args=('acme',), daemon=True)
        releaser.start()
        issuer = None
        try:
            self.assertTrue(entered.wait(5), 'release never reached its pause')

            def issue():
                try:
                    issuer_result.append(
                        relay.store_visitor_key('acme', relay.key_hash('v2'), relay.key_hash('k1')))
                except relay.WriteBusy:
                    issuer_result.append('busy')
                finally:
                    issuer_done.set()
            issuer = threading.Thread(target=issue, daemon=True)
            issuer.start()
            self.assertTrue(issuer_done.wait(10), 'issuer did not finish')
            resume.set()
            releaser.join(10)
            self.assertFalse(releaser.is_alive(), 'release did not finish')
            self.assertIsNone(self.stored_hash())
            self.assertIsNone(self.binding_row())
            self.assertIn(issuer_result[0] if issuer_result else None, (False, 'busy'))
        finally:
            resume.set()
            releaser.join(5)
            if issuer is not None:
                issuer.join(5)

    def test_http_visitor_key_authorized_before_release_answers_404(self) -> None:
        # C2: a visitor-key issuance paused after authorization and before
        # storing, across a DELETE and rebind, answers 404 and plants nothing;
        # removing the handler's false-store 404 branch turns this into a 200.
        # The new owner's current credential must survive the stale request
        # exactly (a stale issuer must not delete or replace it).
        relay = self.relay
        self.bind('acme', 'k1')
        self.assertTrue(relay.store_visitor_key('acme', relay.key_hash('v1'), relay.key_hash('k1')))
        _server, port = self.start_server()
        entered, resume = threading.Event(), threading.Event()
        original_store = relay.store_visitor_key

        def paused_store(name, visitor_hash, link_hash):
            entered.set()
            if not resume.wait(10):
                raise TimeoutError('store was not resumed')
            return original_store(name, visitor_hash, link_hash)
        relay.store_visitor_key = paused_store
        self.addCleanup(setattr, relay, 'store_visitor_key', original_store)
        result = []
        issuer = threading.Thread(
            target=lambda: result.append(
                self.api(port, 'POST', '/api/v1/links/acme/visitor-key', key='k1')),
            daemon=True)
        issuer.start()
        try:
            self.assertTrue(entered.wait(5), 'issuance never reached its pause')
            relay.release_binding('acme')
            self.bind('acme', 'k2')
            # the new owner's current credential lands before the stale request
            # resumes, through the captured original helper, not the pause hook
            self.assertTrue(original_store('acme', relay.key_hash('v2'), relay.key_hash('k2')))
            resume.set()
            issuer.join(10)
            self.assertFalse(issuer.is_alive(), 'issuance did not finish')
            status, _body = result[0]
            # I8: fixed messages only; a key-bearing body must never be rendered
            self.assertEqual(status, 404, 'a stale issuance must answer 404')
            self.assertTrue(self.stored_hash() == relay.key_hash('v2'),
                            'the stale issuance disturbed the new owner credential')
            status, body = self.api(port, 'POST', '/api/v1/links/acme/visitor-key', key='k2')
            self.assertEqual(status, 200, 'the new owner must be able to issue a visitor key')
            self.assertTrue(self.stored_hash() == relay.key_hash(body['visitorKey']),
                            'the rotated hash must match the new visitor key')
        finally:
            resume.set()
            issuer.join(5)

    def test_http_delete_authorized_before_ban_preserves_blocked_binding(self) -> None:
        # C2 concurrent ban: a DELETE paused after authorization, across an
        # operator ban, fails closed (404) and preserves the blocked row, its
        # ban and the visitor credential. An unguarded release erases the ban
        # and fails this test.
        relay = self.relay
        self.bind('acme', 'k1')
        self.assertTrue(relay.store_visitor_key('acme', relay.key_hash('v1'), relay.key_hash('k1')))
        _server, port = self.start_server()
        entered, resume, restore = self.pause_release_once(relay)
        self.addCleanup(restore)
        result = []
        first = threading.Thread(
            target=lambda: result.append(
                self.api(port, 'DELETE', '/api/v1/bindings/acme', key='k1')),
            daemon=True)
        first.start()
        try:
            self.assertTrue(entered.wait(5), 'DELETE never reached its pause')
            relay.write('UPDATE bindings SET banned_at = ?, ban_reason = ? WHERE name = ?',
                        (relay.now(), 'operator', 'acme'))
            resume.set()
            first.join(10)
            self.assertFalse(first.is_alive(), 'DELETE did not finish')
            status, _body = result[0]
            self.assertEqual(status, 404, 'a DELETE banned mid-flight must fail closed')
            row = self.binding_row()
            self.assertIsNotNone(row, 'the blocked binding must survive')
            self.assertIsNotNone(row[1], 'the ban must survive')
            self.assertEqual(row[0], relay.key_hash('k1'))
            self.assertTrue(self.stored_hash() == relay.key_hash('v1'),
                            'the blocked binding credential must survive')
        finally:
            resume.set()
            first.join(5)

    def test_release_rolls_back_when_binding_delete_fails(self) -> None:
        # C2: a failure in the second delete leaves both the binding and its
        # visitor credential in place; a non-transactional release has already
        # dropped the credential and fails this test.
        relay = self.relay
        self.bind('acme', 'k1')
        self.assertTrue(relay.store_visitor_key('acme', relay.key_hash('v1'), relay.key_hash('k1')))
        original_write = relay.write

        def failing_write(sql, args):
            if sql.startswith('DELETE FROM bindings'):
                raise RuntimeError('injected failure')
            original_write(sql, args)
        relay.write = failing_write
        self.addCleanup(setattr, relay, 'write', original_write)
        with self.assertRaises(RuntimeError):
            relay.release_binding('acme')
        # I8: boolean form, so a plaintext store regression renders no credential.
        self.assertTrue(self.stored_hash() == relay.key_hash('v1'),
                        'the stored visitor hash does not match the issued key')
        self.assertIsNotNone(self.binding_row())

    def test_admin_unban_real_binding_keeps_binding_and_credential(self) -> None:
        # C2: ban then unban of a real binding lifts the block and preserves
        # the binding and its stored visitor credential.
        relay = self.relay
        self.bind('acme', 'k1')
        self.assertTrue(relay.store_visitor_key('acme', relay.key_hash('v1'), relay.key_hash('k1')))
        self.admin('ban', 'acme', 'test ban')
        self.assertIsNotNone(self.binding_row()[1])
        self.assertTrue(relay.visitor_hash_matches('acme', 'v1'))
        self.admin('unban', 'acme')
        row = self.binding_row()
        self.assertIsNotNone(row)
        self.assertIsNone(row[1])
        self.assertEqual(row[0], relay.key_hash('k1'))
        # I8: boolean form, so a plaintext store regression renders no credential.
        self.assertTrue(self.stored_hash() == relay.key_hash('v1'),
                        'the stored visitor hash does not match the issued key')
        self.assertTrue(relay.visitor_hash_matches('acme', 'v1'))

    def test_admin_unban_placeholder_removes_credential_and_old_visitor_access(self) -> None:
        # C2: unban of a placeholder ban removes the placeholder and any
        # credential on it; a later recreation is a fresh owner with no old
        # visitor access.
        relay = self.relay
        self.admin('ban', 'placeholder-name', 'placeholder')
        row = self.binding_row('placeholder-name')
        self.assertIsNotNone(row)
        self.assertEqual(row[0], '-')
        relay.db().execute('INSERT INTO visitor_keys (name, key_hash, created_at) VALUES (?, ?, ?)',
                           ('placeholder-name', relay.key_hash('old-visitor'), relay.now()))
        self.admin('unban', 'placeholder-name')
        self.assertIsNone(self.binding_row('placeholder-name'))
        self.assertIsNone(self.stored_hash('placeholder-name'))
        created = json.loads(self.admin('add', 'placeholder-name'))
        self.assertEqual(created['name'], 'placeholder-name')
        self.assertIsNotNone(self.binding_row('placeholder-name'))
        self.assertFalse(relay.visitor_hash_matches('placeholder-name', 'old-visitor'))

    def test_http_delete_authorized_before_release_cannot_drop_new_owner(self) -> None:
        # C2 stale DELETE: a DELETE paused after authorization, across a second
        # DELETE and rebind, must refuse the stale request (404) and leave the
        # new owner's binding and credential untouched.
        relay = self.relay
        self.bind('acme', 'k1')
        self.assertTrue(relay.store_visitor_key('acme', relay.key_hash('v1'), relay.key_hash('k1')))
        _server, port = self.start_server()
        entered, resume, restore = self.pause_release_once(relay)
        self.addCleanup(restore)
        result = []
        first = threading.Thread(
            target=lambda: result.append(
                self.api(port, 'DELETE', '/api/v1/bindings/acme', key='k1')),
            daemon=True)
        first.start()
        try:
            self.assertTrue(entered.wait(5), 'DELETE never reached its pause')
            status, _body = self.api(port, 'DELETE', '/api/v1/bindings/acme', key='k1')
            self.assertEqual(status, 204)
            self.bind('acme', 'k2')
            self.assertTrue(relay.store_visitor_key('acme', relay.key_hash('v2'), relay.key_hash('k2')))
            resume.set()
            first.join(10)
            self.assertFalse(first.is_alive(), 'DELETE did not finish')
            status, _body = result[0]
            self.assertEqual(status, 404, 'a DELETE from an older lifetime must fail closed')
            row = self.binding_row()
            self.assertIsNotNone(row)
            self.assertEqual(row[0], relay.key_hash('k2'))
            self.assertTrue(self.stored_hash() == relay.key_hash('v2'),
                            'the stale DELETE disturbed the new owner credential')
        finally:
            resume.set()
            first.join(5)


if __name__ == '__main__':
    unittest.main()
