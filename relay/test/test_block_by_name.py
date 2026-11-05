"""Blocking by name, per connection (R7.4): frps asks the plugin about every new connection to an https or stcp proxy."""

import http.client
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import ssl
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

if __package__:
    from . import test_peers
    from .harness import ROOT, Answer, Stack, _wait, load_relay_module, render_caddyfile
    from .test_sni import PASSED, PassthroughCase
else:
    import test_peers
    from harness import ROOT, Answer, Stack, _wait, load_relay_module, render_caddyfile
    from test_sni import PASSED, PassthroughCase


M8 = test_peers.M8
TOKEN = 'the edge token of this test'
OWNERS_KEY = 'k'
BLOCKED = {'reject': True, 'reject_reason': 'blocked'}
FREED = {'reject': True, 'reject_reason': 'freed'}
CROWD = 200
CROWD_SECONDS = 2
# Review Focus 5. What keeps a connection waiting is pinned without a clock in NoWaitTests.
WAIT_LIMIT_MS = 50
STALLED_CALLS_ALLOWED = CROWD // 20


def peer_helpers() -> type[unittest.TestCase]:
    """Task 6's helpers, which ask nothing of self but a TestCase's own. A name for the class at the top of this module
    would make unittest run all of its tests here too."""
    return test_peers.PeerTests


def new_user_conn(proxy_name: object, proxy_type: object, metas: object = None) -> dict:
    """A NewUserConn's content as frps sends it: user is the proxy owner's, with what it logged in with, remote_addr the
    visitor's. By default the owner is the one with the key of RelayRuleCase's bindings."""
    return {'user': {'user': '', 'metas': {'key': OWNERS_KEY} if metas is None else metas, 'run_id': 'a run'},
            'proxy_name': proxy_name, 'proxy_type': proxy_type, 'remote_addr': '203.0.113.9:40000'}


class BlockByNameTests(PassthroughCase):
    def assert_refused_at_once(self, host: str) -> None:
        started = time.monotonic()
        refused = self.stack.https(host)
        elapsed = time.monotonic() - started
        self.assertIsNone(refused.status, refused)
        self.assertLess(elapsed, 1, refused.error)

    def peer_with_a_visitor(self, name: str) -> int:
        """Task 6's setup: a -peer machine offers its app service, and a visitor machine opens it on the port returned."""
        key = self.stack.bind(name)['key']
        status, body = self.stack.api('POST', f'/api/v1/links/{name}/visitor-key', key=key)
        self.assertEqual(status, 200, 'issuing a visitor key must answer 200')
        service, secret, port = f'{name}-{M8}-app', secrets.token_hex(20), self.stack._free_port()
        peer = self.stack.client(name, key, settings='network', client=f'{name}-{M8}-peer',
                                 proxies=peer_helpers().stcp_proxies(self, (service, secret, self.stack.echo_port)))
        self.assertTrue(peer.started(service), peer.log())
        visitor = self.stack.client(name, None, settings='network', client=f'{name}-77aa0011-visit',
                                    visitor_key=body['visitorKey'],
                                    proxies=peer_helpers().visitor_proxy(self, service, secret, port))
        self.assertTrue(_wait(lambda: 'start visitor success' in visitor.log(), 15), visitor.log())
        return port

    def test_r7_4_blocked_https_name(self) -> None:
        self.holder('acme')
        answer, kept = self.stack.https('acme.hornhoof.org', keep=True)
        self.assertEqual(answer.status, 200, answer.error)
        frps_started = Path(self.stack.env['RELAY_FRPS_STARTED']).read_text()
        self.stack.admin('ban', 'acme')
        self.assert_refused_at_once('acme.hornhoof.org')
        again = kept.again('/y')
        self.assertEqual(again.status, 200, again.error)
        self.assertEqual(Path(self.stack.env['RELAY_FRPS_STARTED']).read_text(), frps_started)

    def test_r7_4_freed_https_name(self) -> None:
        _, key = self.holder('acme')
        self.assertEqual(self.stack.https('acme.hornhoof.org').status, 200)
        status, _ = self.stack.api('DELETE', '/api/v1/bindings/acme', key=key)
        self.assertEqual(status, 204)
        self.assert_refused_at_once('acme.hornhoof.org')

    def test_r7_4_blocked_peers(self) -> None:
        acme, globex = self.peer_with_a_visitor('acme'), self.peer_with_a_visitor('globex')
        for port in (acme, globex):
            peer_helpers().echo(self, port)
        self.stack.admin('ban', 'acme')
        peer_helpers().echo_closes_silent(self, acme)
        peer_helpers().echo(self, globex)

    def test_edge_never_refused(self) -> None:
        self.holder('acme')
        self.stack.admin('ban', 'acme')
        self.assertEqual(self.stack.https('hornhoof.org').status, 200)
        self.assertEqual(self.stack.https('nobody.hornhoof.org').status, 404)

    def test_r6_1_a_key_change_leaves_new_connections_open(self) -> None:
        # frps sends the metas of the tunnel's login, with the key it logged in with, for as long as that tunnel lives.
        _, key = self.holder('acme')
        status, _ = self.stack.api('POST', '/api/v1/links/acme/key', key=key)
        self.assertEqual(status, 200, 'changing the key must answer 200')
        answer = self.stack.https('acme.hornhoof.org')
        self.assertEqual(answer.status, 200, answer.error)

    def test_r7_4_a_new_owner_never_opens_the_old_owners_tunnel(self) -> None:
        # An operator's add does not ask frps, so it is a way for a live tunnel to find its name bound again.
        _, key = self.holder('acme')
        self.assertEqual(self.stack.https('acme.hornhoof.org').status, 200)
        self.assertEqual(self.stack.api('DELETE', '/api/v1/bindings/acme', key=key)[0], 204)
        self.stack.admin('add', 'acme')
        self.assert_refused_at_once('acme.hornhoof.org')

    def crowd(self, host: str, seconds: float) -> list[Answer]:
        """CROWD connections, one request each, spread evenly over these seconds."""
        answers: list[Answer | None] = [None] * CROWD

        def visit(index: int) -> None:
            answers[index] = self.stack.https(host)

        visitors = [threading.Thread(target=visit, args=(index,), daemon=True) for index in range(CROWD)]
        started = time.monotonic()
        for index, visitor in enumerate(visitors):
            time.sleep(max(0.0, started + index * seconds / CROWD - time.monotonic()))
            visitor.start()
        for visitor in visitors:
            visitor.join(60)
        return answers

    def assert_crowd_let_through(self, answers: list[Answer | None]) -> list[dict]:
        """Every visitor answered and none refused; the crowd's NewUserConn calls."""
        self.assertEqual([answer for answer in answers if answer is None or answer.status != 200], [])
        calls = [call for call in self.stack.plugin_calls()
                 if call['op'] == 'NewUserConn' and call['proxy_name'] == 'acme']
        self.assertEqual(len(calls), CROWD)
        self.assertEqual([call for call in calls if call['reject']], [])
        return calls

    def test_new_user_conn_burst(self) -> None:
        self.holder('acme')
        calls = self.assert_crowd_let_through(self.crowd('acme.hornhoof.org', CROWD_SECONDS))
        waits = sorted(call['ms'] for call in calls)
        print(f'\nNewUserConn in a crowd of {CROWD}: median {statistics.median(waits)} ms, worst {waits[-1]} ms')
        # A machine's stall lands on the few calls in flight at that moment, and calls this far apart rarely overlap. It says
        # nothing of relay.py, whose own causes of a wait NoWaitTests and WaitsNoTraceLineShowsTests pin. A slow path in
        # relay.py shows in every call or in many.
        self.assertLessEqual(len([wait for wait in waits if wait >= WAIT_LIMIT_MS]), STALLED_CALLS_ALLOWED, waits[-20:])
        traces = [line for line in self.stack.relay.log().splitlines() if line.startswith('TRACE ')]
        self.assertGreaterEqual(len(traces), CROWD)
        self.assertEqual([line for line in traces if 'remote_addr' in line or '127.0.0.1' in line], [])

    def test_a_crowd_at_once_is_refused_nowhere(self) -> None:
        self.holder('acme')
        self.assert_crowd_let_through(self.crowd('acme.hornhoof.org', 0))

    def test_new_user_conn_relay_down(self) -> None:
        self.holder('acme')
        self.assertEqual(self.stack.https('acme.hornhoof.org').status, 200)
        self.stack.stop_relay()
        down = self.stack.https('acme.hornhoof.org')
        self.assertIsNone(down.status, down)
        self.stack.start_relay()
        self.assertTrue(_wait(lambda: self.stack.https('acme.hornhoof.org').status == 200, 3))


class RelayRuleCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-block-'))
        self.relay = load_relay_module()
        self.relay.DB_PATH = str(Path(tmp) / 'relay.db')
        self.relay.EDGE_TOKEN = TOKEN
        self.relay.init_db()
        self.addCleanup(self.relay.db().close)
        self.bind('acme')
        self.bind('my-co')
        self.bind('data-app')
        self.bind('globex', banned_at=1)

    def bind(self, name: str, banned_at: int | None = None) -> None:
        self.relay.write('INSERT INTO bindings (name, key_hash, created_at, banned_at) VALUES (?, ?, 0, ?)',
                         (name, self.relay.key_hash(OWNERS_KEY), banned_at))

    def decide(self, content: dict) -> dict:
        return self.relay.plugin('NewUserConn', content)


class ConnectionRuleTests(RelayRuleCase):
    """R7.4's rule on relay.py itself, for what a real frps would never send."""

    def test_an_https_name_needs_a_binding_with_no_ban(self) -> None:
        self.assertEqual(self.decide(new_user_conn('acme', 'https')), PASSED)
        self.assertEqual(self.decide(new_user_conn('globex', 'https')), BLOCKED)
        self.assertEqual(self.decide(new_user_conn('nobody', 'https')), FREED)

    def test_a_service_belongs_to_the_link_before_its_machine(self) -> None:
        for service, answer in (('acme-3f2a9c1b-app', PASSED), ('acme-3f2a9c1b-data', PASSED),
                                ('my-co-3f2a9c1b-app', PASSED), ('data-app-3f2a9c1b-data', PASSED),
                                ('globex-3f2a9c1b-app', BLOCKED), ('nobody-3f2a9c1b-data', FREED)):
            with self.subTest(service):
                self.assertEqual(self.decide(new_user_conn(service, 'stcp')), answer)

    def test_anything_else_is_refused(self) -> None:
        for proxy_name, proxy_type in (('acme', 'http'), ('acme', 'tcp'), ('acme', None), ('acme', 'HTTPS'),
                                       ('acme', 'stcp'), ('acme-data', 'stcp'), ('acme-3f2a9c1b', 'stcp'),
                                       ('acme-3f2a9c1b-other', 'stcp'), ('acme-3F2A9C1B-app', 'stcp'),
                                       ('acme-3f2a9c1b-peer', 'stcp'), ('acme-3f2a9c1b-app', 'https'),
                                       (None, 'https'), (7, 'https'), (['acme'], 'https'), ('', 'https')):
            with self.subTest(proxy_name=proxy_name, proxy_type=proxy_type):
                self.assertIs(self.decide(new_user_conn(proxy_name, proxy_type))['reject'], True)
        self.assertIs(self.decide({})['reject'], True)

    def test_the_edge_passes_on_its_token_alone(self) -> None:
        self.assertEqual(self.decide(new_user_conn('edge', 'https', {'edge': TOKEN})), PASSED)
        for metas in ({'edge': 'wrong'}, {'edge': ''}, {'edge': 7}, {}, 'not an object'):
            with self.subTest(metas_are_a=type(metas).__name__):
                self.assertIs(self.decide(new_user_conn('edge', 'https', metas))['reject'], True)

    def test_a_binding_named_edge_opens_nothing_without_the_token(self) -> None:
        self.bind('edge')
        self.assertIs(self.decide(new_user_conn('edge', 'https'))['reject'], True)

    def test_no_token_set_refuses_the_edge(self) -> None:
        self.relay.EDGE_TOKEN = ''
        for token in ('', TOKEN):
            with self.subTest(token_is_empty=not token):
                self.assertIs(self.decide(new_user_conn('edge', 'https', {'edge': token}))['reject'], True)

    def test_the_edge_token_opens_only_the_edge(self) -> None:
        self.assertEqual(self.decide(new_user_conn('globex', 'https', {'edge': TOKEN})), BLOCKED)

    def test_a_tunnel_of_a_changed_key_stays(self) -> None:
        # The tunnel of a changed key still sends the key it logged in with, and a live tunnel stays (R6.1).
        self.assertTrue(self.relay.store_link_key('acme', self.relay.key_hash('new'), self.relay.key_hash(OWNERS_KEY)))
        self.assertTrue(self.relay.store_link_key('acme', self.relay.key_hash('newer'), self.relay.key_hash('new')))
        for key in (OWNERS_KEY, 'new', 'newer'):
            with self.subTest(key_of_the_tunnel=key):
                self.assertEqual(self.decide(new_user_conn('acme', 'https', {'key': key})), PASSED)

    def test_a_tunnel_of_an_earlier_owner_opens_nothing_under_a_new_binding(self) -> None:
        # frps sends its owner's login as it was. A binding it never logged in with is another company's.
        for proxy_name, proxy_type in (('acme', 'https'), ('acme-3f2a9c1b-app', 'stcp')):
            with self.subTest(proxy_type=proxy_type):
                metas = {'name': 'acme', 'key': 'the key of the earlier owner'}
                self.assertEqual(self.decide(new_user_conn(proxy_name, proxy_type, metas)), FREED)

    def test_a_tunnel_with_no_usable_key_opens_nothing(self) -> None:
        for metas in ({}, {'key': ''}, {'key': 7}, {'key': None}, 'not an object'):
            with self.subTest(metas=metas):
                self.assertEqual(self.decide(new_user_conn('acme', 'https', metas)), FREED)


class NoWaitTests(RelayRuleCase):
    """Review Focus 5 without a clock: every thing that could make a crowd wait on relay.py, shown not to."""

    def test_an_answer_is_one_select_by_the_binding_name(self) -> None:
        statements: list[str] = []
        connection = self.relay.db()
        connection.set_trace_callback(statements.append)
        self.addCleanup(connection.set_trace_callback, None)
        self.assertEqual(self.decide(new_user_conn('acme', 'https')), PASSED)
        connection.set_trace_callback(None)
        self.assertEqual(len(statements), 1, statements)
        self.assertTrue(statements[0].startswith('SELECT'), statements)
        steps = connection.execute(f'EXPLAIN QUERY PLAN {statements[0]}').fetchall()
        self.assertEqual(len(steps), 1, steps)
        self.assertIn('SEARCH bindings USING', steps[0][3])

    def test_an_answer_never_reads_the_dashboard(self) -> None:
        with patch.object(self.relay, '_dash_get', side_effect=AssertionError('a dashboard read')):
            self.assertEqual(self.decide(new_user_conn('acme', 'https')), PASSED)
            self.assertEqual(self.decide(new_user_conn('acme-3f2a9c1b-app', 'stcp')), PASSED)

    def test_a_stalled_commit_and_a_held_route_keep_no_connection_waiting(self) -> None:
        # A write would be refused past its budget here, and a route's lock would never come.
        stalled = sqlite3.connect(self.relay.DB_PATH, isolation_level=None)
        self.addCleanup(stalled.close)
        stalled.execute('BEGIN IMMEDIATE')
        self.addCleanup(stalled.execute, 'ROLLBACK')
        answers = []

        def answer_on_a_new_connection() -> None:
            # A new thread opens its own SQLite connection, as for each new connection from frps to the relay.
            answers.append(self.decide(new_user_conn('acme', 'https')))
            self.relay.db().close()

        with self.relay.writer.changed:
            self.relay.writer.taken = True
        with self.relay.route_lock('acme'):
            thread = threading.Thread(target=answer_on_a_new_connection, daemon=True)
            thread.start()
            thread.join(5)
        self.assertFalse(thread.is_alive(), 'the connection waited')
        self.assertEqual(answers, [PASSED])


class ThreadConnectionTests(RelayRuleCase):
    def test_a_finished_connection_leaves_no_sqlite_connection_open(self) -> None:
        # Each connection from frps is a thread, and a crowd is that many threads, each with a connection of its own that
        # only the garbage collector would close.
        opened = []
        relay = self.relay

        class Watched(relay.Handler):
            def do_GET(self) -> None:
                opened.append(relay.db())
                super().do_GET()

        def closed(connection: sqlite3.Connection) -> bool:
            # A closed connection refuses this from any thread, and an open one answers it from any thread.
            try:
                connection.total_changes
            except sqlite3.ProgrammingError:
                return True
            return False

        with relay.RelayServer(('127.0.0.1', 0), Watched) as server:
            threading.Thread(target=server.handle_request, daemon=True).start()
            client = http.client.HTTPConnection(*server.server_address, timeout=10)
            self.addCleanup(client.close)
            client.request('GET', '/nowhere')
            self.assertEqual(client.getresponse().status, 404)
            client.close()
            self.assertTrue(_wait(lambda: closed(opened[0]), 3), 'the thread ended and its connection stayed open')


class WaitsNoTraceLineShowsTests(RelayRuleCase):
    """A trace line's ms starts once the request is read and ends before its answer goes out. frps waits for the rest too,
    and neither wait is a matter of how loaded the machine is, so these tests hold no clock."""

    def test_an_answer_leaves_at_once_on_a_kept_connection(self) -> None:
        # An answer is two writes, its headers and its body. Under Nagle's rule the body waits for the ACK of the headers,
        # which the receiver delays by 40 ms: measured 44 ms per answer, on the connections frps keeps. The socket option
        # stands in for that measurement, which would need a clock on a shared machine.
        no_delay = []

        class Watched(self.relay.Handler):
            def do_GET(self) -> None:
                no_delay.append(self.connection.getsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY))
                super().do_GET()

        with self.relay.RelayServer(('127.0.0.1', 0), Watched) as server:
            threading.Thread(target=server.handle_request, daemon=True).start()
            client = http.client.HTTPConnection(*server.server_address, timeout=10)
            self.addCleanup(client.close)
            client.request('GET', '/nowhere')
            self.assertEqual(client.getresponse().status, 404)
        self.assertEqual(len(no_delay), 1)
        self.assertTrue(no_delay[0], 'the body of an answer waits for the ACK of its headers')

    def test_a_crowd_of_new_connections_fits_the_queue(self) -> None:
        # frps keeps two connections to the relay and opens one more for each call beyond those, so a crowd is that many at
        # once. Past the queue the kernel drops one, and its retry comes 200 ms to 1 s later. Nothing accepts here, so
        # all of them must fit.
        with self.relay.RelayServer(('127.0.0.1', 0), self.relay.Handler) as server:
            connections = [socket.create_connection(server.server_address, timeout=5) for _ in range(CROWD)]
            for connection in connections:
                connection.close()


class AdminCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-ban-')))
        self.env = dict(os.environ, RELAY_DB=str(self.tmp / 'relay.db'), RELAY_CADDYFILE=str(self.tmp / 'Caddyfile'))
        (self.tmp / 'Caddyfile').write_text('')


class BanCommandTests(AdminCase):
    def run_admin(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, str(ROOT / 'relay/relay.py'), 'admin', *args], env=self.env,
                              capture_output=True, text=True, timeout=30)

    def admin(self, *args: str) -> list[str]:
        finished = self.run_admin(*args)
        self.assertEqual(finished.returncode, 0, finished.stderr)
        return finished.stdout.splitlines()

    def banned_names(self) -> list[str]:
        with sqlite3.connect(self.env['RELAY_DB']) as connection:
            return [row[0] for row in connection.execute('SELECT name FROM bindings WHERE banned_at IS NOT NULL')]

    def ban_reason(self, name: str) -> str:
        with sqlite3.connect(self.env['RELAY_DB']) as connection:
            return connection.execute('SELECT ban_reason FROM bindings WHERE name = ?', (name,)).fetchone()[0]

    def test_ban_cut_prints_restart(self) -> None:
        self.assertEqual(self.admin('ban', 'acme', '--cut')[-1], 'restart frps')
        self.assertNotIn('restart frps', self.admin('ban', 'globex'))

    def test_cut_is_no_part_of_the_reason(self) -> None:
        self.admin('ban', 'acme', 'stolen', 'machine', '--cut')
        self.assertEqual(self.ban_reason('acme'), 'stolen machine')
        self.admin('ban', 'globex', '--cut')
        self.assertEqual(self.ban_reason('globex'), 'blocked by the relay operator')

    def test_cut_may_come_before_the_name(self) -> None:
        self.assertEqual(self.admin('ban', '--cut', 'acme', 'stolen')[-1], 'restart frps')
        self.assertEqual(self.banned_names(), ['acme'])
        self.assertEqual(self.ban_reason('acme'), 'stolen')

    def test_a_ban_takes_only_what_can_be_a_name(self) -> None:
        for name in ('--cat', 'not_a_name', 'ab--cd'):
            with self.subTest(name=name):
                refused = self.run_admin('ban', name, 'acme')
                self.assertEqual(refused.returncode, 1, refused.stdout)
                self.assertEqual(self.banned_names(), [])

    def test_a_ban_with_no_name_says_how_to_use_it(self) -> None:
        refused = self.run_admin('ban', '--cut')
        self.assertEqual(refused.returncode, 2, refused.stdout)
        self.assertNotIn('restart frps', refused.stdout)
        self.assertIn('usage', refused.stderr)


class OperatorCommandTests(AdminCase):
    """hornhoof-relay itself, its own text, with stand-ins for what only the droplet has."""

    def setUp(self) -> None:
        super().setUp()
        self.calls = self.tmp / 'systemctl-calls'
        stand_ins = self.tmp / 'bin'
        stand_ins.mkdir()
        (self.tmp / 'caddy').mkdir()
        (stand_ins / 'runuser').write_text('#!/bin/sh\nshift 3\nexec "$@"\n')
        (stand_ins / 'systemctl').write_text(f'#!/bin/sh\necho "$@" >> {self.calls}\n')
        for stand_in in stand_ins.iterdir():
            stand_in.chmod(0o755)
        self.env['PATH'] = f'{stand_ins}:{self.env["PATH"]}'
        self.script = self.tmp / 'hornhoof-relay'
        self.script.write_text(render_caddyfile((ROOT / 'relay/hornhoof-relay').read_text(), [
            ('/usr/bin/python3 /usr/local/lib/hornhoof-relay/relay.py', f'{sys.executable} {ROOT}/relay/relay.py'),
            ('/etc/caddy', str(self.tmp / 'caddy')),
        ], file='relay/hornhoof-relay'))

    def operator(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(['sh', str(self.script), *args], env=self.env, capture_output=True, text=True,
                              timeout=30)

    def systemctl_calls(self) -> list[str]:
        return self.calls.read_text().splitlines() if self.calls.exists() else []

    def test_a_ban_with_cut_restarts_frps_after_caddys_list(self) -> None:
        done = self.operator('ban', 'acme', '--cut')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.systemctl_calls(), ['reload caddy', 'restart frps'])
        self.assertIn('acme.hornhoof.org', (self.tmp / 'caddy/blocked.caddy').read_text())

    def test_a_ban_with_cut_first_blocks_the_name_it_was_given(self) -> None:
        done = self.operator('ban', '--cut', 'acme')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.systemctl_calls(), ['reload caddy', 'restart frps'])
        self.assertIn('acme.hornhoof.org', (self.tmp / 'caddy/blocked.caddy').read_text())

    def test_the_help_promises_what_a_ban_does(self) -> None:
        # A live https tunnel's visitors get a closed connection: the 410 page comes only once that tunnel is gone.
        help_text = ' '.join(line.lstrip('# ') for line in (ROOT / 'relay/hornhoof-relay').read_text().splitlines()
                             if line.startswith('#'))
        self.assertNotIn('answer 410 at once', help_text)
        self.assertIn('refuses new connections at once', help_text)

    def test_a_ban_without_cut_restarts_nothing(self) -> None:
        done = self.operator('ban', 'acme', 'restart', 'frps')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.systemctl_calls(), ['reload caddy'])

    def test_the_operator_still_reads_what_the_relay_says(self) -> None:
        self.assertIn('ban acme: done', self.operator('ban', 'acme').stdout)
        self.assertIn('acme  created', self.operator('list').stdout)

    def test_a_ban_the_store_refused_restarts_nothing(self) -> None:
        self.env['RELAY_DB'] = str(self.tmp / 'no-such-folder' / 'relay.db')
        done = self.operator('ban', 'acme', '--cut')
        self.assertNotEqual(done.returncode, 0)
        self.assertEqual(self.systemctl_calls(), [])


class RefusedVisitorAddressTests(unittest.TestCase):
    def refused_connection(self, stack: Stack, host: str) -> int:
        """The local port of a connection frps closes during its handshake, which an Answer cannot carry."""
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        plain = socket.create_connection(('127.0.0.1', stack.https_port), timeout=10)
        self.addCleanup(plain.close)
        port = plain.getsockname()[1]
        with self.assertRaises(OSError):
            context.wrap_socket(plain, server_hostname=host, do_handshake_on_connect=True)
        return port

    def test_a_refused_visitor_leaves_no_address_on_the_droplet(self) -> None:
        tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-block-logs-'))
        stack = self.enterContext(Stack(tmp, caddy=True, droplet_logging=True))
        company = stack.client('acme', stack.bind('acme')['key'], settings='network', client='acme-aaaaaaaa-link',
                               proxy_type='https')
        self.assertTrue(company.started('acme'), company.log())
        stack.admin('ban', 'acme')
        visitor_port = self.refused_connection(stack, 'acme.hornhoof.org')
        refusals = [call for call in stack.plugin_calls() if call['op'] == 'NewUserConn' and call['reject']]
        self.assertEqual([call['proxy_name'] for call in refusals], ['acme'])
        for name, process in (('frps', stack.frps), ('edge', stack.edge), ('caddy', stack.caddy),
                              ('relay', stack.relay)):
            with self.subTest(process=name):
                self.assertNotIn(f'127.0.0.1:{visitor_port}', process.log())
                self.assertNotIn(f'"remote_port":"{visitor_port}"', process.log())


if __name__ == '__main__':
    unittest.main()
