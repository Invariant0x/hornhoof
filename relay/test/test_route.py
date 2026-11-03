"""Who holds a name: R1.1, R1.2, R2.1 and R2.3 against a real frps."""

import contextlib
import importlib.util
import io
import http.client
import json
import os
import re
import sqlite3
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

if __package__:
    from .harness import Stack, _request, _wait
else:
    from harness import Stack, _request, _wait

ROOT = Path(__file__).resolve().parents[2]
SUCCESS = re.compile(r'\[acme\]\s+start proxy success\b')
# A refusal is one of these documented reasons; anything else in an outcome is a failure.
REFUSALS = frozenset({'router config conflict: acme is held', 'relay error: frps does not answer',
                      'relay error: busy'})


def first_outcome(log: str):
    """A tunnel client's first outcome: 'started', or the refusal reason of its first start error."""
    for line in log.splitlines():
        if 'start proxy success' in line:
            return 'started'
        if 'start error:' in line:
            return line.split('start error:', 1)[1].strip()
    return None


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-route-'))
        self.stack = self.enterContext(Stack(self.tmp))
        self.binding = self.stack.bind('acme')
        self.key = self.binding['key']

    def route(self, name='acme', key=None):
        return self.stack.api('GET', f'/api/v1/links/{name}/route', key=self.key if key is None else key)

    def newproxy_calls(self):
        return [call for call in self.stack.plugin_calls() if call['op'] == 'NewProxy']

    def race(self, clients, ids, base):
        """Wait until every client has its first outcome (started, or its refusal reason) and the
        trace holds one NewProxy record per client id; return (records, outcomes).
        base is the trace length before the clients were created."""
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            calls = self.newproxy_calls()[base:]
            outcomes = [first_outcome(client.log()) for client in clients]
            traced = {call['client'] for call in calls}
            if all(outcomes) and all(client_id in traced for client_id in ids):
                return calls, outcomes
            time.sleep(0.1)
        raise AssertionError('no outcome: ' + ' | '.join(c.log()[-200:] for c in clients))

    def test_first_outcome_takes_any_refusal_reason(self):
        self.assertEqual(first_outcome('trying\n[x] start proxy success'), 'started')
        reason = first_outcome('[x] start error: relay error: frps does not answer')
        self.assertEqual(reason, 'relay error: frps does not answer')
        self.assertIsNone(first_outcome('trying to connect'))

    def test_r2_1_held_then_empty(self):
        status, body = self.route()
        self.assertEqual(status, 200)
        self.assertEqual(body['state'], 'empty')
        self.assertEqual(body['generation'], 0)
        client = self.stack.client('acme', self.key)
        self.assertTrue(client.started('acme'), client.log())
        status, body = self.route()
        self.assertEqual(status, 200)
        self.assertEqual(body['state'], 'held')
        self.assertEqual(body['client'], 'legacy')
        self.assertEqual(body['generation'], 1)
        stopped = time.time()
        client.stop()
        self.assertTrue(_wait(lambda: self.route()[1]['state'] == 'empty', 5))
        status, body = self.route()
        self.assertEqual(body['generation'], 1)
        self.assertGreaterEqual(body['since'], int(stopped))
        for call in self.newproxy_calls():
            self.assertLess(call['ms'], 1000, call)

    def test_r1_1_second_registration_refused(self):
        first = self.stack.client('acme', self.key, settings='network', client='acme-aaaaaaaa-link')
        self.assertTrue(first.started('acme'), first.log())
        second = self.stack.client('acme', self.key, settings='network', client='acme-bbbbbbbb-link')
        self.assertFalse(second.started('acme', within=2), second.log())
        self.assertIn('router config conflict', second.log())
        status, body = self.route()
        self.assertEqual(status, 200)
        self.assertEqual(body['state'], 'held')
        self.assertEqual(body['client'], 'acme-aaaaaaaa-link')
        self.assertEqual(body['generation'], 1)
        rejected = [call for call in self.newproxy_calls()
                    if call['reject'] and call['client'] == 'acme-bbbbbbbb-link']
        self.assertTrue(rejected)
        for call in self.newproxy_calls():
            self.assertLess(call['ms'], 1000, call)

    def test_r1_1_racing_registrations(self):
        ids = [f'acme-{i:08d}-link' for i in range(10)]
        base = len(self.newproxy_calls())
        clients = [self.stack.client('acme', self.key, settings='network', client=i) for i in ids]
        calls, outcomes = self.race(clients, ids, base)
        self.assertEqual(len(calls), len(clients))
        started = [i for i, outcome in zip(ids, outcomes) if outcome == 'started']
        self.assertEqual(len(started), 1, outcomes)
        refused = [outcome for outcome in outcomes if outcome != 'started']
        self.assertTrue(all(outcome in REFUSALS for outcome in refused), outcomes)
        let_through = [call for call in calls if not call['reject']]
        self.assertEqual(len(let_through), 1)
        status, body = self.route()
        self.assertEqual(body['state'], 'held')
        self.assertEqual(body['client'], started[0])
        self.assertEqual(body['generation'], len(let_through))
        for call in calls:
            self.assertLess(call['ms'], 1000, call)

    def test_r1_1_race_after_empty(self):
        first = self.stack.client('acme', self.key, settings='network', client='acme-aaaaaaaa-link')
        self.assertTrue(first.started('acme'), first.log())
        status, body = self.route()
        self.assertEqual(body['state'], 'held')  # the row is held, not pending, before the race
        generation = body['generation']
        first.stop()
        self.assertTrue(_wait(lambda: self.route()[1]['state'] == 'empty', 5))
        ids = [f'acme-{i:08d}-link' for i in range(10)]
        base = len(self.newproxy_calls())
        clients = [self.stack.client('acme', self.key, settings='network', client=i) for i in ids]
        calls, outcomes = self.race(clients, ids, base)
        self.assertEqual(len(calls), len(clients))
        started = [i for i, outcome in zip(ids, outcomes) if outcome == 'started']
        self.assertEqual(len(started), 1, outcomes)
        refused = [outcome for outcome in outcomes if outcome != 'started']
        self.assertTrue(all(outcome in REFUSALS for outcome in refused), outcomes)
        let_through = [call for call in calls if not call['reject']]
        self.assertEqual(len(let_through), 1)
        status, body = self.route()
        self.assertEqual(body['generation'], generation + len(let_through))
        self.assertEqual(body['client'], started[0])
        for call in calls:
            self.assertLess(call['ms'], 1000, call)

    def test_r1_2_shared_routes_refused(self):
        cases = [
            ('group', '\nloadBalancer.group = "g"\nloadBalancer.groupKey = "k"\n'),
            ('locations', '\nlocations = ["/x"]\n'),
            ('route_by_http_user', '\nrouteByHTTPUser = "u"\n'),
        ]
        for field, extra in cases:
            with self.subTest(field=field):
                client = self.stack.client('acme', self.key, proxies=f'''
[[proxies]]
name = "acme"
type = "http"
subdomain = "acme"
localIP = "127.0.0.1"
localPort = {self.stack.echo_port}{extra}
''')
                self.assertFalse(client.started('acme', within=2), client.log())
                self.assertIn(f'{field} is not allowed', client.log())

    def test_r2_3_errors_are_not_empty(self):
        status, body = self.route(key='x')
        self.assertEqual(status, 401)
        self.assertEqual(body['error'], 'unauthorized')
        status, body = self.route('nope')
        self.assertEqual(status, 404)
        self.assertEqual(body['error'], 'not_found')
        tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-route-nodash-'))
        with Stack(tmp, dashboard=False) as stack:
            binding = stack.bind('acme')
            status, body = stack.api('GET', '/api/v1/links/acme/route', key=binding['key'])
            self.assertEqual(status, 503)
            self.assertEqual(body['error'], 'unknown')
            client = stack.client('acme', binding['key'])
            self.assertFalse(client.started('acme', within=2), client.log())
            self.assertIn('relay error: frps does not answer', client.log())

    def test_r2_3_online_route_without_a_row_is_unknown(self):
        first = self.stack.client('acme', self.key, settings='network', client='acme-aaaaaaaa-link')
        self.assertTrue(first.started('acme'), first.log())
        with sqlite3.connect(str(Path(self.tmp) / 'relay.db'), timeout=5) as conn:
            conn.execute("DELETE FROM routes WHERE name = 'acme'")
        status, body = self.route()
        self.assertEqual(status, 503)
        self.assertEqual(body['error'], 'unknown')
        self.assertIn('route of acme', self.stack.relay.log())
        second = self.stack.client('acme', self.key, settings='network', client='acme-bbbbbbbb-link')
        self.assertFalse(second.started('acme', within=2), second.log())
        self.assertIn('relay error: frps does not answer', second.log())

    def test_plugin_calls_stay_short(self):
        first = self.stack.client('acme', self.key, settings='network', client='acme-aaaaaaaa-link')
        self.assertTrue(first.started('acme'), first.log())
        second = self.stack.client('acme', self.key, settings='network', client='acme-bbbbbbbb-link')
        self.assertFalse(second.started('acme', within=2), second.log())
        self.assertGreaterEqual(len(self.newproxy_calls()), 2)
        for call in self.newproxy_calls():
            self.assertLess(call['ms'], 1000, call)

    def test_busy_write_answers_503_instead_of_dropping_the_connection(self):
        # A contended API write answers 503 busy with Retry-After; it never drops the
        # connection mid-request (R2.3: a relay error is a structured answer, not a hangup).
        db = sqlite3.connect(str(Path(self.tmp) / 'relay.db'), timeout=10, isolation_level=None)
        self.addCleanup(db.close)
        db.execute('BEGIN IMMEDIATE')
        db.execute("INSERT INTO creations (ip, at) VALUES ('holding the write lock', 0)")
        try:
            for method, path, body in (('POST', '/api/v1/bindings', b'{}'),
                                       ('DELETE', '/api/v1/bindings/acme', None)):
                with self.subTest(method=method):
                    connection = http.client.HTTPConnection('127.0.0.1', self.stack.relay_port,
                                                            timeout=5)
                    connection.request(method, path, body=body,
                                       headers={'Content-Type': 'application/json',
                                                'Authorization': f'Bearer {self.key}'})
                    response = connection.getresponse()
                    self.assertEqual(response.status, 503)
                    self.assertEqual(response.getheader('Retry-After'), '1')
                    answer = json.loads(response.read())
                    self.assertEqual(answer['error'], 'busy')
                    connection.close()
        finally:
            db.execute('ROLLBACK')

    def test_r2_1_route_body_has_no_key(self):
        client = self.stack.client('acme', self.key, settings='network', client='acme-aaaaaaaa-link')
        self.assertTrue(client.started('acme'), client.log())
        status, raw = _request(self.stack.relay_port, 'GET', '/api/v1/links/acme/route',
                               headers={'Authorization': f'Bearer {self.key}'})
        self.assertEqual(status, 200)
        text = raw.decode()
        self.assertNotIn(self.key, text)
        self.assertNotIn('key', text)


def _relay_module():
    spec = importlib.util.spec_from_file_location('relay_under_test', ROOT / 'relay' / 'relay.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _record(status, payload=None, delay=0.0):
    return status, json.dumps(payload if payload is not None else {}).encode(), delay


def _restore_env(name, old):
    if old is None:
        os.environ.pop(name, None)
    else:
        os.environ[name] = old


def _release_lock(lock):
    try:
        lock.release()
    except RuntimeError:
        pass


class _YieldingWriter(io.TextIOBase):
    """A stdout stand-in that hands over to other threads between write calls, so a writer that
    emits a record in more than one write (like print) interleaves its parts."""

    def __init__(self):
        self._parts = []
        self._lock = threading.Lock()

    def writable(self):
        return True

    def write(self, text):
        with self._lock:
            self._parts.append(text)
        time.sleep(0.01)  # let another thread's write slot in before this call's next part
        return len(text)

    def flush(self):
        pass

    def getvalue(self):
        return ''.join(self._parts)


class _DashboardHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        status, body, delay = self.server.records.get(self.path, (404, b'{}', 0.0))
        if delay:
            time.sleep(delay)
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the relay hung up when its budget-capped read timed out


class DashboardContractTests(unittest.TestCase):
    """frps_route against a fake dashboard: both types are read, every record is validated."""

    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), _DashboardHandler)
        cls.server.daemon_threads = True
        cls.server.records = {}
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.relay = _relay_module()
        cls.relay.RELAY_FRPS_API = f'http://127.0.0.1:{cls.server.server_port}'
        cls.relay.FRPS_USER = 'admin'
        cls.relay.FRPS_PASSWORD = 'test'
        cls.addClassCleanup(setattr, cls.relay, 'DB_PATH', cls.relay.DB_PATH)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def setUp(self):
        self.tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-dash-'))
        self.relay.DB_PATH = str(Path(self.tmp) / 'relay.db')
        self.relay._local.__dict__.clear()
        self.relay.init_db()
        self.server.records.clear()

    def _bind(self, name: str, key: str) -> None:
        self.relay.db().execute('INSERT INTO bindings (name, key_hash, created_at, created_ip) '
                                'VALUES (?, ?, ?, ?)',
                                (name, self.relay.key_hash(key), self.relay.now(), 'test'))

    @staticmethod
    def _newproxy_content(name: str, key: str, client: str) -> dict:
        return {'user': {'user': '', 'metas': {'name': name, 'key': key, 'client': client}, 'run_id': 'r1'},
                'proxy_name': name, 'proxy_type': 'http', 'subdomain': name}

    def test_reads_http_then_https_and_rejects_both_found(self):
        record = _record(200, {'status': 'online', 'clientID': 'c1'})
        self.server.records['/api/proxy/http/acme'] = record
        self.server.records['/api/proxy/https/acme'] = record
        with self.assertRaises(self.relay.FrpsUnknown):
            self.relay.frps_route('acme')

    def test_online_http_route_is_returned_with_its_type(self):
        self.server.records['/api/proxy/http/acme'] = _record(200, {'status': 'online', 'clientID': 'c1'})
        self.assertEqual(self.relay.frps_route('acme'), ('online', 'c1', 'http'))

    def test_online_https_route_is_returned_with_its_type(self):
        self.server.records['/api/proxy/https/acme'] = _record(200, {'status': 'offline', 'clientID': 'c2'})
        self.assertEqual(self.relay.frps_route('acme'), ('offline', 'c2', 'https'))

    def test_absent_only_when_both_types_are_404(self):
        self.assertEqual(self.relay.frps_route('acme'), ('absent', None, None))

    def test_missing_client_id_is_unknown(self):
        self.server.records['/api/proxy/http/acme'] = _record(200, {'status': 'online'})
        with self.assertRaises(self.relay.FrpsUnknown):
            self.relay.frps_route('acme')

    def test_empty_client_id_is_unknown(self):
        self.server.records['/api/proxy/http/acme'] = _record(200, {'status': 'online', 'clientID': ''})
        with self.assertRaises(self.relay.FrpsUnknown):
            self.relay.frps_route('acme')

    def test_unknown_status_value_is_unknown(self):
        self.server.records['/api/proxy/http/acme'] = _record(200, {'status': 'starting', 'clientID': 'c1'})
        with self.assertRaises(self.relay.FrpsUnknown):
            self.relay.frps_route('acme')

    def test_other_status_code_is_unknown(self):
        self.server.records['/api/proxy/http/acme'] = _record(500)
        with self.assertRaises(self.relay.FrpsUnknown):
            self.relay.frps_route('acme')

    def test_watcher_takes_a_slow_good_healthz_answer(self):
        # The watcher's probe budget is 1 s for each probe: a good dashboard answer arriving
        # at 0.7 s means frps is up, not down.
        old_bind = self.relay.RELAY_FRPS_BIND
        self.addCleanup(setattr, self.relay, 'RELAY_FRPS_BIND', old_bind)
        self.relay.RELAY_FRPS_BIND = f'127.0.0.1:{self.server.server_port}'
        self.server.records['/healthz'] = _record(200, delay=0.7)
        self.assertTrue(self.relay.frps_answers())

    def test_straighten_empties_the_row_as_read(self):
        t = self.relay.now()
        self.relay.db().execute("INSERT INTO routes (name, generation, client, run_id, type, state, since) "
                                "VALUES ('acme', 5, 'c1', 'r1', 'http', 'held', ?)", (t,))
        self.relay.straighten_route('acme', (5, 'c1', 'r1', 'http', 'held', t), 'offline', t + 1)
        row = self.relay.db().execute("SELECT generation, state FROM routes WHERE name = 'acme'").fetchone()
        self.assertEqual((row[0], row[1]), (5, 'empty'))

    def test_straighten_never_clears_a_fresher_generation(self):
        # A straighten from a read taken before a newer registration landed in the same
        # second must not clear that registration: every UPDATE is guarded by the
        # generation (and state) as read, not by the second-resolution since.
        t = self.relay.now()
        self.relay.db().execute("INSERT INTO routes (name, generation, client, run_id, type, state, since) "
                                "VALUES ('acme', 5, 'c1', 'r1', 'http', 'pending', ?)", (t,))
        stale = (4, 'c0', 'r0', 'http', 'held', t)
        self.relay.straighten_route('acme', stale, 'offline', t)
        row = self.relay.db().execute("SELECT generation, state FROM routes WHERE name = 'acme'").fetchone()
        self.assertEqual((row[0], row[1]), (5, 'pending'))

    def test_young_pending_reads_held_against_an_offline_record(self):
        # R1.1: frps keeps the previous registration's offline record until the new one shows,
        # so an offline record must not empty a pending row younger than PENDING_S, or two
        # racing registrations would both get through.
        t = self.relay.now()
        self.relay.db().execute("INSERT INTO routes (name, generation, client, run_id, type, state, since) "
                                "VALUES ('acme', 1, 'acme-c1-link', 'r1', 'http', 'pending', ?)", (t,))
        self.server.records['/api/proxy/http/acme'] = _record(200, {'status': 'offline', 'clientID': 'acme-c0-link'})
        body = self.relay.route_of('acme')
        self.assertEqual(body['state'], 'held')
        self.assertEqual(body['generation'], 1)
        self._bind('acme', 'k')
        reason = self.relay.plugin('NewProxy', self._newproxy_content('acme', 'k', 'acme-c2-link'))
        self.assertEqual(reason, {'reject': True, 'reject_reason': 'router config conflict: acme is held'})
        row = self.relay.db().execute("SELECT generation, state FROM routes WHERE name = 'acme'").fetchone()
        self.assertEqual((row[0], row[1]), (1, 'pending'))

    def _refuse_in_worker(self, hold_s: float) -> tuple[list, float]:
        """Run one real NewProxy plugin call on a worker thread while this thread holds the lock
        for hold_s seconds; return (results, seconds from the call's start to its answer)."""
        lock = self.relay.route_lock('acme')
        lock.acquire()
        entered = threading.Event()
        result = []

        def run():
            entered.set()
            result.append(self.relay.plugin('NewProxy', self._newproxy_content('acme', 'k', 'acme-c1-link')))

        worker = threading.Thread(target=run)
        worker.start()
        self.assertTrue(entered.wait(timeout=5))
        started = time.monotonic()
        timer = threading.Timer(hold_s, lock.release)
        timer.start()
        try:
            worker.join(timeout=8)
            elapsed = time.monotonic() - started
        finally:
            timer.cancel()
            _release_lock(lock)
        self.assertFalse(worker.is_alive(), 'plugin call outlived its 1 s budget')
        return result, elapsed

    def test_newproxy_call_is_refused_within_one_second(self):
        # A registration waiting behind a slow route read must not wait it out (Review Focus 3):
        # one plugin call gets one 1 s budget, and a lock that cannot be taken in time refuses.
        self._bind('acme', 'k')
        result, elapsed = self._refuse_in_worker(2.0)
        self.assertLess(elapsed, 1.1, f'refusal took {elapsed:.2f} s')
        self.assertEqual(result[-1], {'reject': True, 'reject_reason': 'relay error: frps does not answer'})

    def test_newproxy_read_uses_the_time_left_after_waiting_for_the_lock(self):
        # After waiting for the lock, a dashboard read may use only the budget left:
        # 0.7 s waiting + a 0.3 s read cap against a 0.6 s dashboard refuses within 1 s.
        self._bind('acme', 'k')
        self.server.records['/api/proxy/http/acme'] = _record(
            200, {'status': 'offline', 'clientID': 'c0'}, delay=0.6)
        result, elapsed = self._refuse_in_worker(0.7)
        self.assertLess(elapsed, 1.1, f'refusal took {elapsed:.2f} s')
        self.assertEqual(result[-1], {'reject': True, 'reject_reason': 'relay error: frps does not answer'})

    def test_slow_answers_still_refuse_within_one_second(self):
        # Every step would succeed given time; the dashboard's good answer just arrives after
        # the budget ran out. The call refuses within 1 s and the generation does not move.
        self._bind('acme', 'k')
        record = _record(200, {'status': 'offline', 'clientID': 'c0'}, delay=0.6)
        self.server.records['/api/proxy/http/acme'] = record
        self.server.records['/api/proxy/https/acme'] = record
        result, elapsed = self._refuse_in_worker(0.4)
        self.assertLess(elapsed, 1.1, f'refusal took {elapsed:.2f} s')
        self.assertEqual(result[-1], {'reject': True, 'reject_reason': 'relay error: frps does not answer'})
        self.assertIsNone(self.relay.db().execute("SELECT generation FROM routes WHERE name = 'acme'").fetchone())

    def test_expired_call_does_not_register(self):
        # Every step would succeed, but the database's write lock stays taken past the call's
        # 1 s budget: the call must refuse with no generation moved, not register late.
        self._bind('acme', 'k')
        conn = self.relay.db()
        conn.execute('BEGIN')
        conn.execute("INSERT INTO creations (ip, at) VALUES ('holding the write lock', 0)")
        try:
            result = []
            worker = threading.Thread(target=lambda: result.append(
                self.relay.plugin('NewProxy', self._newproxy_content('acme', 'k', 'acme-c1-link'))))
            started = time.monotonic()
            worker.start()
            worker.join(timeout=8)
            elapsed = time.monotonic() - started
        finally:
            conn.execute('ROLLBACK')
        self.assertFalse(worker.is_alive(), 'plugin call outlived its 1 s budget')
        self.assertLess(elapsed, 1.6, f'refusal took {elapsed:.2f} s')
        self.assertEqual(result[-1], {'reject': True, 'reject_reason': 'relay error: busy'})
        self.assertIsNone(self.relay.db().execute("SELECT generation FROM routes WHERE name = 'acme'").fetchone())

    def test_write_refuses_before_executing_when_the_call_budget_is_spent(self):
        # A spent budget must not run the SQL at all: write refuses before executing, or an
        # expired upsert would move a generation after the call should have refused.
        self.relay.call_state.end = time.monotonic() - 0.1
        self.addCleanup(setattr, self.relay.call_state, 'end', None)
        with self.assertRaises(self.relay.WriteBusy):
            self.relay.write("INSERT INTO creations (ip, at) VALUES ('spent budget', 1)", ())
        self.assertIsNone(self.relay.db().execute(
            "SELECT 1 FROM creations WHERE ip = 'spent budget'").fetchone())

    def test_login_refuses_busy_when_the_write_lock_is_held(self):
        # touch() is a write too: a Login whose last_seen update cannot land inside the call's
        # budget is refused with 'relay error: busy', not accepted late without the touch.
        self._bind('acme', 'k')
        conn = self.relay.db()
        conn.execute('BEGIN')
        conn.execute("INSERT INTO creations (ip, at) VALUES ('holding the write lock', 0)")
        try:
            result = []
            worker = threading.Thread(target=lambda: result.append(
                self.relay.plugin('Login', {'metas': {'name': 'acme', 'key': 'k'}, 'run_id': 'r1'})))
            started = time.monotonic()
            worker.start()
            worker.join(timeout=8)
            elapsed = time.monotonic() - started
        finally:
            conn.execute('ROLLBACK')
        self.assertFalse(worker.is_alive(), 'plugin call outlived its 1 s budget')
        self.assertLess(elapsed, 1.6, f'refusal took {elapsed:.2f} s')
        self.assertEqual(result[-1], {'reject': True, 'reject_reason': 'relay error: busy'})
        self.assertIsNone(self.relay.db().execute(
            "SELECT last_seen FROM bindings WHERE name = 'acme'").fetchone()[0])

    def test_trace_lines_are_atomic_under_concurrency(self):
        old = os.environ.get('RELAY_TRACE')
        os.environ['RELAY_TRACE'] = '1'
        self.addCleanup(_restore_env, 'RELAY_TRACE', old)
        count = 16
        output = _YieldingWriter()
        barrier = threading.Barrier(count)

        def emit(i):
            barrier.wait(timeout=10)
            content = {'user': {'run_id': f'r{i}', 'metas': {'client': f'c{i}'}}}
            self.relay.trace_plugin('Ping', content, {'reject': False}, time.monotonic())

        with contextlib.redirect_stdout(output):
            threads = [threading.Thread(target=emit, args=(i,)) for i in range(count)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=10)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), count)
        for line in lines:
            value = json.loads(line.removeprefix('TRACE '))
            self.assertEqual(value['op'], 'Ping')


if __name__ == '__main__':
    unittest.main()
