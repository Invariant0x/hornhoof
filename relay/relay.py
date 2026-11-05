#!/usr/bin/env python3
"""Hornhoof relay: hands out <name>.hornhoof.org links and checks every tunnel that frps lets in.

Public API (Caddy sends https://hornhoof.org/api/* here):
  GET    /api/v1/names/{name}      -> 200 {name, free, reason?: taken|reserved|invalid}, 503 if unknown
  POST   /api/v1/bindings          {name?} -> 201 {name, url, key, tunnel}, 409 taken, 503 if unknown
  DELETE /api/v1/bindings/{name}   Authorization: Bearer <key> -> 204 (404 once the name belongs to a new owner)
  GET    /api/v1/links/{name}/route Authorization: Bearer <key> -> 200 {state, client, since, generation, ...}
  POST   /api/v1/links/{name}/sync  Authorization: Bearer <key> {client, generation, state, copy, epoch} -> 200 {sync}
  POST   /api/v1/links/{name}/key   Authorization: Bearer <key> {key?} -> 200 {key}, 400 invalid|same_key (R6.1)
  POST   /api/v1/links/{name}/visitor-key Authorization: Bearer <key> -> 200 {visitorKey} (R6.2)
  GET    /api/v1/health            -> 200 {ok, frps, relayStarted, passthrough} while frps takes logins, else 503
frps plugin (local only): POST /frp/handler?op=Login|NewProxy|Ping|NewUserConn
Admin (as the service user): relay.py admin list|add|ban|unban|release|banned-caddy ...

Standard library only. State: SQLite in /var/lib/hornhoof-relay/relay.db. Keys are stored as SHA-256 hashes.
"""
import base64
import collections
import contextlib
import hashlib
import hmac
import http.client
import json
import os
import re
import secrets
import socket
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, urlsplit

DOMAIN = 'hornhoof.org'
DB_PATH = os.environ.get('RELAY_DB', '/var/lib/hornhoof-relay/relay.db')
CADDYFILE = os.environ.get('RELAY_CADDYFILE', '/etc/caddy/Caddyfile')
LISTEN = ('127.0.0.1', int(os.environ.get('RELAY_PORT', '7600')))
FRPC_IMAGE = 'fatedier/frpc:v0.71.1@sha256:7a0a18bc9c83dc106a7e5213a890f521affdf90d595829c56b0ed8481377d50e'
FRPC_CONFIG_PATH = '/etc/frp/frpc.toml'
TARGET_HOST, TARGET_PORT = 'app', 8080

# Bindings per client address per hour, and for everyone together; name checks per address per minute.
BIND_PER_IP_HOUR = 5
BIND_ALL_HOUR = 300
CHECKS_PER_IP_MINUTE = 60
BAD_KEYS_PER_IP_HOUR = 30
MAX_BODY = 4096

# frps's dashboard API (loopback only): the one source for whether a route is live.
RELAY_FRPS_API = os.environ.get('RELAY_FRPS_API', 'http://127.0.0.1:7500')
FRPS_USER = os.environ.get('RELAY_FRPS_USER', 'admin')
FRPS_PASSWORD = os.environ.get('RELAY_FRPS_PASSWORD', '')
# The watcher probes these to know whether frps takes logins (R4.1); systemd's ExecStartPost
# rewrites the started file every time frps starts.
RELAY_FRPS_BIND = os.environ.get('RELAY_FRPS_BIND', '127.0.0.1:7000')
RELAY_FRPS_STARTED = os.environ.get('RELAY_FRPS_STARTED', '/run/frps/started')
# frps's https port; health says whether it accepts connections (R4.1). Unset, nothing is passed through.
RELAY_FRPS_HTTPS = os.environ.get('RELAY_FRPS_HTTPS', '')
# The one client that may carry hornhoof.org and everything no company claims on to Caddy (R7.5). Its token is the only
# proof: every tunnel reaches frps from Caddy on loopback, so an address proves nothing. Unset, no login is the edge.
EDGE_TOKEN = os.environ.get('RELAY_EDGE_TOKEN', '')
EDGE_CLIENT = 'edge'
EDGE_DOMAINS = [DOMAIN, '*']
EDGE_REFUSED = 'edge login refused'
# A registration frps has not shown yet reads as held for this long (R1.1, R2.1).
PENDING_S = 10
# R3.1 measured with frp 0.71.1: network 20.16/20.46 s, today 20.26 s (2026-11-03).
EVICTION_BOUND_S = 30
# One budget per plugin call: a spent budget refuses the op, fail closed (Review Focus 3). The one thing that outlasts it
# is a write already in a commit, which waits for the outcome: see WriteTicket.time_left.
PLUGIN_CALL_S = 1.0

LABEL = re.compile(r'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
CONTENT_LENGTH = re.compile(r'[0-9]{1,18}')
RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
# JSON's "\ud800" decodes to a string with no UTF-8 form, which SQLite cannot store.
LONE_SURROGATE = re.compile('[\ud800-\udfff]')
# A network client's id: <link>-<machine8>-<kind> (R1.3, R1.4, R5.1).
CLIENT = re.compile(r'^(?P<link>[a-z0-9-]{1,63})-(?P<m8>[0-9a-f]{8})-(?P<kind>link|peer|visit)$')
# A key a link's owner may choose: 32 bytes in base64url without padding (R6.1).
CHOSEN_KEY = re.compile(r'[A-Za-z0-9_-]{43}')
BAD_KEY_BODY = 'Send no body, {}, or {"key": <32 bytes in base64url without padding>}.'
# The two stcp services a -peer client may offer, named <link>-<m8>-<service> (R5.1).
PEER_SERVICES = ('data', 'app')


def now() -> int:
    return int(time.time())


def key_hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


_local = threading.local()
# One deadline per plugin call: the lock and every dashboard read draw from the time left.
call_state = threading.local()


def call_deadline() -> float | None:
    """Seconds left in the current plugin call's budget; None outside plugin calls."""
    end = getattr(call_state, 'end', None)
    return None if end is None else max(0.0, end - time.monotonic())


def db() -> sqlite3.Connection:
    conn = getattr(_local, 'conn', None)
    if conn is None:
        conn = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA synchronous=FULL')
        conn.execute('PRAGMA busy_timeout=10000')
        _local.conn = conn
    return conn


def close_db() -> None:
    """Close this thread's connection, which db() would leave open for the garbage collector once the thread ends."""
    conn = getattr(_local, 'conn', None)
    if conn is not None:
        conn.close()
        _local.conn = None


# Every object of the schema, by the name sqlite_master knows it by.
SCHEMA = {
    'bindings': '''CREATE TABLE IF NOT EXISTS bindings (
            name TEXT PRIMARY KEY,
            key_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            created_ip TEXT,
            last_seen INTEGER,
            banned_at INTEGER,
            ban_reason TEXT
        )''',
    'creations': 'CREATE TABLE IF NOT EXISTS creations (ip TEXT NOT NULL, at INTEGER NOT NULL)',
    'creations_at': 'CREATE INDEX IF NOT EXISTS creations_at ON creations(at)',
    'routes': '''CREATE TABLE IF NOT EXISTS routes (
            name TEXT PRIMARY KEY,
            generation INTEGER NOT NULL,
            client TEXT NOT NULL,
            run_id TEXT NOT NULL,
            type TEXT NOT NULL CHECK (type IN ('http', 'https')),
            state TEXT NOT NULL CHECK (state IN ('pending', 'held', 'empty')),
            since INTEGER NOT NULL
        )''',
    'sync': '''CREATE TABLE IF NOT EXISTS sync (
            name TEXT PRIMARY KEY,
            state TEXT NOT NULL CHECK (state IN ('on', 'off')),
            copy TEXT,
            epoch INTEGER NOT NULL,
            generation INTEGER NOT NULL,
            at INTEGER NOT NULL
        )''',
    'visitor_keys': '''CREATE TABLE IF NOT EXISTS visitor_keys (
            name TEXT PRIMARY KEY,
            key_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )''',
    'ping_keys': '''CREATE TABLE IF NOT EXISTS ping_keys (
            name TEXT NOT NULL,
            key_hash TEXT NOT NULL,
            link_hash TEXT NOT NULL,
            PRIMARY KEY (name, key_hash)
        )''',
}


def init_db() -> None:
    """Make what is missing. A made database takes no write lock: an admin command that only reads must not wait for,
    or fail behind, a long commit of the service."""
    made = {row[0] for row in db().execute('SELECT name FROM sqlite_master')}
    for name, statement in SCHEMA.items():
        if name not in made:
            write(statement, ())


_reserved = {'mtime': None, 'names': frozenset()}


def reserved_names() -> frozenset:
    """The names on the Caddyfile's @reserved line, reread when the file changes."""
    try:
        mtime = os.stat(CADDYFILE).st_mtime
    except OSError:
        return _reserved['names']
    if mtime != _reserved['mtime']:
        names = set()
        with open(CADDYFILE) as f:
            for line in f:
                parts = line.split()
                if parts[:2] == ['@reserved', 'host']:
                    names.update(h[: -len('.' + DOMAIN)] for h in parts[2:] if h.endswith('.' + DOMAIN))
        _reserved.update(mtime=mtime, names=frozenset(names))
    return _reserved['names']


def declared_body_length(headers) -> int | None:
    """The bytes a request's one Content-Length promises, 0 with none, None when it cannot be trusted."""
    values = headers.get_all('Content-Length', [])
    if not values:
        return 0
    if len(values) > 1 or not CONTENT_LENGTH.fullmatch(values[0]):
        return None
    return int(values[0])


def label_valid(name: str) -> bool:
    return LABEL.fullmatch(name) is not None and name[2:4] != '--'


def check_name(name: str):
    """None when the name can be bound, else 'invalid', 'reserved' or 'taken'. A banned name counts as reserved."""
    if not label_valid(name):
        return 'invalid'
    if name in reserved_names():
        return 'reserved'
    row = db().execute('SELECT banned_at FROM bindings WHERE name = ?', (name,)).fetchone()
    if row is None:
        return None
    return 'reserved' if row[0] else 'taken'


# relayStarted is the latest of: this process's start, the watcher's first frps answer after
# a failure or after start, and the integer in RELAY_FRPS_STARTED (R2.2, R4.1).
STARTED = now()

# frps watcher state: frps_ok_at is the epoch of the last good probe, frps_back_at the epoch
# of the first good probe after a failure or after start (0 until then).
_frps = {'ok_at': 0.0, 'back_at': 0, 'passthrough': False}
WATCH_INTERVAL_S = 0.5
# Health answers 200 only while the watcher's last good probe is younger than this.
HEALTH_MAX_AGE_S = 2.0


def port_accepts(address: str) -> bool:
    """True when host:port takes a connection within 1 s; an unset or malformed address does not."""
    host, _, port_text = address.rpartition(':')
    try:
        connection = socket.create_connection((host, int(port_text)), timeout=1)
        connection.close()
    except (OSError, ValueError, OverflowError):
        return False
    return True


def frps_answers() -> bool:
    """True when frps's bind port accepts a connection and its dashboard answers /healthz."""
    if not port_accepts(RELAY_FRPS_BIND):
        return False
    try:
        status, _ = _dash_get('/healthz', cap=1.0)
    except FrpsUnknown:
        return False
    return status == 200


def frps_came_back() -> None:
    """Probes before the good answer is published, and after frps answered, so that the first healthy answer already
    says whether the https port, which frps opens before its dashboard, takes connections. No good answer is out yet,
    so this wait cannot make one look old."""
    _frps['passthrough'] = port_accepts(RELAY_FRPS_HTTPS)
    _frps['back_at'] = time.time()


def watch_once(was_ok: bool) -> bool:
    """One probe of frps: a good answer is stamped at once. Says whether frps answered."""
    if not frps_answers():
        return False
    if not was_ok:
        frps_came_back()
    _frps['ok_at'] = time.time()
    return True


def watch_frps() -> None:
    """Probe frps forever; keep the last good answer and the recovery after a failure."""
    was_ok = False
    while True:
        was_ok = watch_once(was_ok)
        time.sleep(WATCH_INTERVAL_S)


def watch_passthrough() -> None:
    """Follow frps's https port while frps answers, on a loop of its own. Between two stamps of frps's answers a probe
    that waits out its timeout would count against HEALTH_MAX_AGE_S, and health would read as the relay being down."""
    while True:
        if frps_ok():
            _frps['passthrough'] = port_accepts(RELAY_FRPS_HTTPS)
        time.sleep(WATCH_INTERVAL_S)


def frps_ok() -> bool:
    """R4.1: true while the watcher's last frps answer is under HEALTH_MAX_AGE_S old."""
    return time.time() - _frps['ok_at'] < HEALTH_MAX_AGE_S


def frps_started_file() -> int:
    """The integer systemd's ExecStartPost wrote when frps last started, 0 when unreadable."""
    try:
        with open(RELAY_FRPS_STARTED) as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return 0


def relay_started() -> int:
    """The latest of the relay's start, the frps recovery and frps's own start."""
    return int(max(STARTED, _frps['back_at'], frps_started_file()))


class FrpsUnknown(Exception):
    """frps's dashboard gave no trustworthy answer about a route: read unknown, never empty."""


def _dash_get(path: str, cap: float = 0.5) -> tuple[int, bytes]:
    """One dashboard read with a cap-second timeout; less when the plugin call's budget is nearly spent.

    The watcher's own probes pass cap=1. Any error, timeout or a spent budget is FrpsUnknown.
    """
    parsed = urlsplit(RELAY_FRPS_API)
    host = parsed.hostname or '127.0.0.1'
    port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    kind = http.client.HTTPSConnection if parsed.scheme == 'https' else http.client.HTTPConnection
    left = call_deadline()
    if left is not None and left <= 0:
        raise FrpsUnknown(f'{path}: plugin call budget spent')
    connection = kind(host, port, timeout=cap if left is None else min(cap, left))
    try:
        token = base64.b64encode(f'{FRPS_USER}:{FRPS_PASSWORD}'.encode()).decode()
        connection.request('GET', path, headers={'Authorization': f'Basic {token}'})
        response = connection.getresponse()
        return response.status, response.read()
    except (OSError, http.client.HTTPException) as e:
        raise FrpsUnknown(f'{path}: {type(e).__name__}') from None
    finally:
        connection.close()


def dash_answer(name: str, proxy_type: str) -> tuple[str, str] | None:
    """One proxy type's dashboard record: (status, clientID), None on 404, FrpsUnknown otherwise.

    A record is trusted only with a status of online or offline and a non-empty clientID:
    a missing field reads as unknown, never as empty.
    """
    status, body = _dash_get(f'/api/proxy/{proxy_type}/{name}')
    if status == 404:
        return None
    if status != 200:
        raise FrpsUnknown(f'dashboard answered {status} for {proxy_type} {name}')
    try:
        answer = json.loads(body)
        route_status = answer['status']
        client_id = answer['clientID']
    except (ValueError, KeyError, TypeError):
        raise FrpsUnknown(f'dashboard body for {proxy_type} {name} has no route record') from None
    if route_status not in ('online', 'offline') or not isinstance(client_id, str) or not client_id:
        raise FrpsUnknown(f'dashboard body for {proxy_type} {name} is not a route record')
    return route_status, client_id


def dash_client_records(body: bytes) -> list[dict]:
    """The parsed clients answer: a list of records with a clientID string and a boolean
    online. Anything else is FrpsUnknown, never an empty guess."""
    try:
        answer = json.loads(body)
    except ValueError:
        raise FrpsUnknown('dashboard clients answer is not JSON') from None
    if not isinstance(answer, list):
        raise FrpsUnknown('dashboard clients answer is not a list')
    for entry in answer:
        if (not isinstance(entry, dict) or not isinstance(entry.get('clientID'), str)
                or not entry['clientID']
                or type(entry.get('online')) is not bool):
            raise FrpsUnknown('dashboard clients answer has no client record')
    return answer


def dash_clients(run_id: str) -> list[dict]:
    """The /api/clients?runId= answer on the plugin call's budget; a dashboard error is
    FrpsUnknown, never an empty guess."""
    status, body = _dash_get(f'/api/clients?runId={quote(run_id, safe="")}')
    if status != 200:
        raise FrpsUnknown(f'dashboard answered {status} for clients runId {run_id}')
    return dash_client_records(body)


def run_id_conflict(run_id: str, client_id: str, name: str) -> str | None:
    """R1.3, C1: a live session with this run id is taken over only by its own.

    A session with a client id names itself by that id. A legacy login names a
    session by its run id, because frps 0.71.1 shows a legacy client's runID as
    its clientID (pinned against the local binary); a live session reached that
    way additionally needs legacy ownership proof, or any foreign binding could
    displace an unrecorded live session (C1). An absent or offline session
    reconnects as before. A dashboard error refuses the login: the relay cannot
    tell whose the run id is.
    """
    try:
        clients = dash_clients(run_id)
    except FrpsUnknown:
        return 'relay error: frps does not answer'
    own = client_id or run_id
    online = False
    for entry in clients:
        if not entry['online']:
            continue
        online = True
        if entry['clientID'] != own:
            return 'this run id belongs to another client'
    if online and not client_id and not legacy_run_id_proven(name, run_id):
        return 'this run id belongs to another client'
    return None


def legacy_run_id_proven(name: str, run_id: str) -> bool:
    """C1: proof that a legacy run id with a live session belongs to this binding.

    The run id must not itself look like a network client id, and the binding's
    own routes ledger must record it as a legacy route: no ledger row, no
    ownership. A recorded same-binding legacy run id keeps its reconnect.
    """
    if CLIENT.fullmatch(run_id):
        return False
    row = db().execute("SELECT 1 FROM routes WHERE name = ? AND client = 'legacy' AND run_id = ? LIMIT 1",
                       (name, run_id)).fetchone()
    return row is not None


def run_id_recorded_elsewhere(run_id: str, name: str) -> bool:
    """True when the route ledger records this run id for another binding (C1).

    A legacy login reusing such a run id would replace that binding's session in frps:
    the dashboard shows the session's clientID as the run id itself, so the dashboard
    check alone cannot refuse it.
    """
    row = db().execute('SELECT 1 FROM routes WHERE run_id = ? AND name != ? LIMIT 1',
                       (run_id, name)).fetchone()
    return row is not None


def frps_route(name: str) -> tuple[str, str | None, str | None]:
    """frps's own view of a name's route: ('online'|'offline', clientID, type), or ('absent', None, None).

    Both proxy types are read: a name holds one route of either type, and two records is unknown.
    """
    http = dash_answer(name, 'http')
    https = dash_answer(name, 'https')
    if http is not None and https is not None:
        raise FrpsUnknown(f'dashboard shows both http and https routes for {name}')
    for proxy_type, answer in (('http', http), ('https', https)):
        if answer is not None:
            return answer[0], answer[1], proxy_type
    return 'absent', None, None


def pending_lapsed(since: int, t: int) -> bool:
    """A registration frps has not shown by now is taken never to come (R2.1)."""
    return t - since > PENDING_S


def route_pending(name: str) -> bool:
    """Whether the plugin let a registration of this name through that frps has not shown yet. Only the relay's row knows
    of it: frps asks the plugin before it makes the proxy, and its dashboard says nothing until then."""
    row = db().execute('SELECT state, since FROM routes WHERE name = ?', (name,)).fetchone()
    return row is not None and row[0] == 'pending' and not pending_lapsed(row[1], now())


def name_live(name: str) -> bool:
    """R1.5: a freed name waits for its old route, shown by frps or only registered so far; an unknown dashboard raises.

    The row goes first: it leaves pending only once frps shows the route, so the later look at frps sees what the row no
    longer says. These are reads alone, so that a public question moves no row and takes no lock: no registration can land
    after them, since this name has no binding by now and a row needs one (store_route).
    """
    pending = route_pending(name)
    return frps_route(name)[0] == 'online' or pending


def requested_name_reason(name: str) -> str | None:
    """Check local restrictions first, then whether frps still serves a freed name."""
    reason = check_name(name)
    if reason is None and name_live(name):
        return 'taken'
    return reason


def check_route_holder(name: str, row, status: str, client_id: str | None, proxy_type: str | None) -> None:
    """An online route must match the relay's own record, else the answer is unknown, never empty (R2.3).

    A missing row means the record was lost while frps holds the route: unknown too.
    """
    if status != 'online':
        return
    matches = (row is not None and proxy_type == row[3]
               and client_id == (row[2] if row[1] == 'legacy' else row[1]))
    if matches:
        return
    log_line(f'route of {name} is online outside the relay record')
    raise FrpsUnknown(f'frps route of {name} does not match the relay record')


class WriteBusy(Exception):
    """A SQLite write could not get its turn within its budget: refuse the op, never guess."""


# The most one write waits in the queue outside a plugin call; inside one, the call's time left may be less.
WRITE_BUDGET_S = 0.8


class WriteTicket:
    """A place in the writer's queue: a statement and, after its commit, its outcome. No statement: a transaction's."""

    def __init__(self, deadline: float, sql: str | None = None, args: tuple = ()):
        self.deadline, self.sql, self.args = deadline, sql, args
        self.claimed = False
        self.done = False
        self.changes = 0
        self.error: Exception | None = None

    def time_left(self) -> float | None:
        """The seconds its owner may still wait; None: until the outcome.

        Queued, that is the write's budget, and the ticket can still leave without a trace. Claimed, its SQL may land, so
        a refusal could be false, and every owner waits for the commit's outcome, a plugin call's too. What a stalled
        disk costs a plugin call is therefore the stall, past its 1 s, and once: its next write refuses at
        write_deadline before any SQL, and the calls queued behind the stalled commit still refuse at their own budgets.
        Python cannot interrupt an fsync, so the thread running that commit could not leave it anyway.
        """
        return None if self.claimed else max(0.0, self.deadline - time.monotonic())

    def refuse(self) -> None:
        """Off the queue with its SQL never run, which is what makes the refusal true."""
        self.claimed, self.done = True, True
        self.error = WriteBusy('past its budget before its commit')

    def run(self, conn: sqlite3.Connection) -> None:
        """A failure that left the transaction open is this statement's own, and the batch goes on: SQLite backed it out
        alone, or one client's value could not even be bound, as a lone surrogate or an int too large cannot. One that
        ended the transaction ends the batch."""
        try:
            self.changes = conn.execute(self.sql, self.args).rowcount
        except Exception as failure:
            if not conn.in_transaction:
                raise
            self.error = failure

    def outcome(self) -> int:
        """The rows the statement changed, or what stopped it."""
        if self.error is not None:
            raise self.error
        return self.changes


class WriterQueue:
    """The one writer of this process, and the writes waiting for it in the order they came (Review Focus 3).

    All writers are threads of one process, so they do not compete for SQLite's lock: SQLite's backoff sleeps up to
    100 ms between tries, and a burst of commits, each with its own fsync, costs more than a plugin call's budget on a
    real disk. Here the first in the queue takes the writer and commits every statement queued by then in one
    transaction, so a burst costs a few fsyncs however large it is, and each statement's owner still answers only after
    its commit.
    """

    def __init__(self) -> None:
        self.changed = threading.Condition()
        self.queue: collections.deque[WriteTicket] = collections.deque()
        self.taken = False

    def wait_for_turn(self, ticket: WriteTicket) -> bool:
        """Queue the ticket. True: this thread now holds the writer. False: another thread's holder dealt with it."""
        with self.changed:
            self.queue.append(ticket)
            while not ticket.done:
                left = ticket.time_left()
                if left == 0:
                    self.leave(ticket)
                    raise WriteBusy('no outcome from the writer within the budget')
                if not self.taken and self.queue[0] is ticket:
                    self.taken = True
                    return True
                self.changed.wait(left)
            return False

    def leave(self, ticket: WriteTicket) -> None:
        with self.changed:
            self.queue.remove(ticket)
            self.changed.notify_all()

    def claim_statements(self) -> list[WriteTicket]:
        """The holder's batch: the queue's head up to a transaction's place, so that a transaction keeps its turn.

        A ticket past its deadline is refused here, as its owner may not have woken yet, and a write its owner hears
        refused must never land.
        """
        with self.changed:
            batch = []
            while self.queue and self.queue[0].sql is not None:
                ticket = self.queue.popleft()
                if ticket.time_left() == 0:
                    ticket.refuse()
                else:
                    ticket.claimed = True
                    batch.append(ticket)
            return batch

    def hand_back(self, batch: list[WriteTicket]) -> None:
        """The holder is finished: its batch has its outcomes, and the next in the queue may take the writer."""
        with self.changed:
            for ticket in batch:
                ticket.done = True
            self.taken = False
            self.changed.notify_all()


writer = WriterQueue()


def write_deadline() -> float:
    """When this write's budget ends; a plugin call whose budget is spent refuses before any SQL runs."""
    left = call_deadline()
    if left is not None and left <= 0:
        raise WriteBusy('plugin call budget spent')
    return time.monotonic() + (WRITE_BUDGET_S if left is None else min(WRITE_BUDGET_S, left))


@contextlib.contextmanager
def locked_is_busy():
    """SQLite's database is locked reads as the relay's one busy refusal."""
    try:
        yield
    except sqlite3.OperationalError as e:
        if 'locked' in str(e):
            raise WriteBusy('database is locked') from None
        raise


def begin_writing(conn: sqlite3.Connection, deadline: float) -> None:
    """Open the holder's transaction. Only another process can hold SQLite's lock now: `relay.py admin`, briefly."""
    left = deadline - time.monotonic()
    conn.execute(f'PRAGMA busy_timeout = {max(0, int(left * 1000))}')
    try:
        with locked_is_busy():
            conn.execute('BEGIN IMMEDIATE')
    finally:
        conn.execute('PRAGMA busy_timeout = 10000')


def roll_back(conn: sqlite3.Connection) -> None:
    """End a transaction a failure left open; SQLite may have ended it already. A connection that cannot end it is
    closed, which does: kept, it would hold SQLite's write lock against every other thread until a restart."""
    if not conn.in_transaction:
        return
    with contextlib.suppress(sqlite3.Error):
        conn.execute('ROLLBACK')
    if conn.in_transaction:
        with contextlib.suppress(sqlite3.Error):
            conn.close()
        _local.conn = None


def fail_batch(conn: sqlite3.Connection, batch: list[WriteTicket], failure: Exception) -> None:
    """None of the batch landed, so that is what every owner hears."""
    roll_back(conn)
    for ticket in batch:
        ticket.error = failure


def commit_batch(conn: sqlite3.Connection, batch: list[WriteTicket]) -> None:
    """One transaction, so one fsync, for the whole batch. A failure lands none of it, so it reaches every owner, and no
    ticket goes back uncommitted with no error."""
    try:
        for ticket in batch:
            ticket.run(conn)
        conn.execute('COMMIT')
    except Exception as failure:
        fail_batch(conn, batch, failure)
    except BaseException:
        # What tears this thread down is its own. The other owners only need to know that nothing landed.
        fail_batch(conn, batch, WriteBusy('the commit was interrupted'))
        raise


def write_the_queue(conn: sqlite3.Connection, ticket: WriteTicket) -> None:
    """This thread holds the writer. Refused by another process's lock, only its own budget is spent: the rest stay."""
    batch = []
    try:
        begin_writing(conn, ticket.deadline)
        batch = writer.claim_statements()
        commit_batch(conn, batch)
    finally:
        if not ticket.claimed:
            writer.leave(ticket)
        writer.hand_back(batch)


def inside_transaction() -> bool:
    """Whether this thread is in `with transaction()`. Not conn.in_transaction: a transaction opened any other way is one
    nobody will commit, and a write inside it would answer with nothing on disk."""
    return getattr(_local, 'inside_transaction', False)


def write(sql: str, args: tuple) -> int:
    """The one SQLite write of the plugin and the API: the rows it changed, on disk before it returns. DDL and COMMIT
    change none and return -1.

    It waits for its turn for the write's budget (WRITE_BUDGET_S, or the plugin call's time left, whichever is less);
    past the budget it raises WriteBusy, a plugin call refuses with 'relay error: busy' (Review Focus 3), and the
    statement can never land. Once in a commit it waits for the outcome. Inside this thread's `with transaction()` it
    runs at once. A statement runs on the connection of whichever thread holds the writer, so its owner reads the
    changed rows from here and not from SELECT changes().
    """
    conn = db()
    deadline = write_deadline()
    with locked_is_busy():
        if inside_transaction():
            return conn.execute(sql, args).rowcount
        ticket = WriteTicket(deadline, sql, args)
        if writer.wait_for_turn(ticket):
            write_the_queue(conn, ticket)
        return ticket.outcome()


def straighten_route(name: str, row, status: str, t: int) -> None:
    """Move the row to what frps shows; each UPDATE is guarded by the generation as read, so a row
    rewritten since we read frps keeps its newer registration. The per-name lock is held.

    A pending row younger than PENDING_S is a registration frps has not shown yet: it reads held
    even when frps still shows the previous registration's offline record, because frps keeps that
    record until the new one shows. Only an online record turns it held, age or absence empties it.
    """
    state, generation = row[4], row[0]
    if status == 'online':
        write("UPDATE routes SET state = 'held' WHERE name = ? AND generation = ? "
              "AND state IN ('pending', 'empty')", (name, generation))
    elif state == 'held':
        write("UPDATE routes SET state = 'empty', since = ? WHERE name = ? AND generation = ? "
              "AND state = 'held'", (t, name, generation))
    elif state == 'pending' and pending_lapsed(row[5], t):
        write("UPDATE routes SET state = 'empty', since = ? WHERE name = ? AND generation = ? "
              "AND state = 'pending'", (t, name, generation))


def route_body(name: str, row) -> dict:
    """The R2.1 answer from a routes row; a name with no row is empty at generation 0."""
    if row is None:
        binding = db().execute('SELECT created_at FROM bindings WHERE name = ?', (name,)).fetchone()
        since = binding[0] if binding else None
        state, client, generation = 'empty', None, 0
    else:
        since = row[5]
        state = 'empty' if row[4] == 'empty' else 'held'
        client = row[1] if state == 'held' else None
        generation = row[0]
    return {'state': state, 'client': client, 'since': since, 'generation': generation,
            'relayStarted': relay_started(), 'evictionBound': EVICTION_BOUND_S, 'sync': sync_of(name)}


def sync_of(name: str) -> dict:
    """The last committed sync record, or the R2.4 default when no holder has set one."""
    row = db().execute('SELECT state, copy, epoch, generation, at FROM sync WHERE name = ?',
                       (name,)).fetchone()
    if row is None:
        return {'state': 'off', 'copy': None, 'epoch': 0, 'generation': 0, 'at': None}
    return dict(zip(('state', 'copy', 'epoch', 'generation', 'at'), row))


def sync_text(value: object) -> bool:
    return isinstance(value, str) and 1 <= len(value) <= 100 and not LONE_SURROGATE.search(value)


def sync_integer(value: object) -> bool:
    """A positive SQLite INTEGER, excluding JSON booleans."""
    return type(value) is int and 1 <= value <= 2 ** 63 - 1


def sync_copy(state: str, copy: object) -> bool:
    return sync_text(copy) or (state == 'off' and copy is None)


def valid_sync_body(body: object) -> bool:
    """Validate the complete R2.4 body, including exact fields and JSON integer types."""
    if not isinstance(body, dict) or set(body) != {'client', 'generation', 'state', 'copy', 'epoch'}:
        return False
    return all((sync_text(body['client']), sync_integer(body['generation']),
                body['state'] in ('on', 'off'), sync_copy(body['state'], body['copy']),
                sync_integer(body['epoch'])))


def sync_holder(name: str, body: dict) -> bool:
    """An online frps route must name this registration; a pending row cannot set sync."""
    route = locked_route_of(name)
    row = db().execute('SELECT state FROM routes WHERE name = ?', (name,)).fetchone()
    return (row == ('held',) and route['client'] == body['client']
            and route['generation'] == body['generation'])


def store_sync(name: str, body: dict, link_hash: str) -> bool:
    """Commit only while the checked registration still holds and the authorizing binding still
    exists, so that a post in flight across a release cannot reach the name's next owner; never
    overwrite a newer epoch."""
    return write('INSERT INTO sync (name, state, copy, epoch, generation, at) '
                 'SELECT name, ?, ?, ?, generation, ? FROM routes '
                 "WHERE name = ? AND generation = ? AND client = ? AND state = 'held' "
                 'AND EXISTS (SELECT 1 FROM bindings WHERE name = ? AND key_hash = ?) '
                 'ON CONFLICT(name) DO UPDATE SET state = excluded.state, copy = excluded.copy, '
                 'epoch = excluded.epoch, generation = excluded.generation, at = excluded.at '
                 'WHERE excluded.epoch > sync.epoch',
                 (body['state'], body['copy'], body['epoch'], now(), name, body['generation'], body['client'],
                  name, link_hash)) == 1


def set_sync(name: str, body: dict, link_hash: str) -> tuple[str | None, dict | None]:
    """Serialize the frps holder check and committed write against the name's registrations."""
    with route_lock(name):
        if not sync_holder(name, body):
            return 'not_holder', None
        if body['epoch'] <= sync_of(name)['epoch']:
            return 'stale_epoch', None
        if not store_sync(name, body, link_hash):
            return 'not_holder', None
        return None, sync_of(name)


def locked_route_of(name: str) -> dict:
    """The R2.1 body with the per-name lock already held: the row straightened against frps."""
    status, client_id, proxy_type = frps_route(name)
    row = db().execute('SELECT generation, client, run_id, type, state, since FROM routes WHERE name = ?',
                       (name,)).fetchone()
    if row is not None:
        check_route_holder(name, row, status, client_id, proxy_type)
        try:
            straighten_route(name, row, status, now())
        except sqlite3.Error as e:
            raise FrpsUnknown(f'route store is not writable: {type(e).__name__}') from None
        row = db().execute('SELECT generation, client, run_id, type, state, since FROM routes WHERE name = ?',
                           (name,)).fetchone()
    else:
        check_route_holder(name, None, status, client_id, proxy_type)
    return route_body(name, row)


def route_of(name: str) -> dict:
    """The R2.1 body for a name: the routes row straightened against what frps shows right now.

    The per-name lock serializes every read-and-straighten against registrations.
    """
    with route_lock(name):
        return locked_route_of(name)


_route_locks_guard = threading.Lock()
_route_locks: dict[str, threading.Lock] = {}


def route_lock(name: str) -> threading.Lock:
    with _route_locks_guard:
        lock = _route_locks.get(name)
        if lock is None:
            lock = threading.Lock()
            _route_locks[name] = lock
    return lock


def hold_route_lock(name: str) -> bool:
    """Take the per-name lock within the plugin call's remaining budget; False when the budget ran out."""
    lock = route_lock(name)
    left = call_deadline()
    if left is None:
        lock.acquire()
        return True
    return left > 0 and lock.acquire(timeout=left)


def register_route(name: str, content: dict) -> str | None:
    """Record a registration the plugin let through; a reason when the name cannot be taken (R1.1)."""
    user = content.get('user') or {}
    if not hold_route_lock(name):
        return 'relay error: frps does not answer'
    try:
        return register_locked(name, content, user)
    finally:
        route_lock(name).release()


def register_locked(name: str, content: dict, user: dict) -> str | None:
    """The locked half of register_route: refuse a held name, else record the registration."""
    try:
        held = locked_route_of(name)['state'] == 'held'
    except FrpsUnknown:
        return 'relay error: frps does not answer'
    except WriteBusy:
        return 'relay error: busy'
    if held:
        return f'router config conflict: {name} is held'
    return upsert_route(name, content, user)


def route_columns(name: str, content: dict, user: dict) -> tuple:
    """A let-through registration's row: the next generation, its maker, and pending since now."""
    row = db().execute('SELECT generation FROM routes WHERE name = ?', (name,)).fetchone()
    generation = (row[0] if row else 0) + 1
    client = (user.get('metas') or {}).get('client') or 'legacy'
    return (name, generation, client, user.get('run_id') or '', content.get('proxy_type') or 'http', 'pending', now())


def store_route(columns: tuple, name: str, link_hash: str) -> bool:
    """Commit the row only while the binding that authorized it still stands, in the one statement, so that a release, a
    key change or a ban since its login check refuses it. A lock could not: `relay.py admin` is another process."""
    return write(
        'INSERT INTO routes (name, generation, client, run_id, type, state, since) SELECT ?, ?, ?, ?, ?, ?, ? '
        'WHERE EXISTS (SELECT 1 FROM bindings WHERE name = ? AND key_hash = ? AND banned_at IS NULL) '
        'ON CONFLICT(name) DO UPDATE SET generation = excluded.generation, client = excluded.client, '
        'run_id = excluded.run_id, type = excluded.type, state = excluded.state, since = excluded.since',
        (*columns, name, link_hash)) == 1


def upsert_route(name: str, content: dict, user: dict) -> str | None:
    """Write the pending row for a let-through registration; a refusal when the write cannot land."""
    metas = user['metas']
    try:
        if store_route(route_columns(name, content, user), name, key_hash(metas['key'])):
            return None
    except WriteBusy:
        return 'relay error: busy'
    except sqlite3.Error:
        return 'relay error: frps does not answer'
    return authenticate(metas)[2] or f'no binding {name} with this key'


def shared_route_fields(content: dict) -> str | None:
    """R1.2: a name is one company's one route, never shared or split across locations or users."""
    for field in ('locations', 'route_by_http_user', 'group'):
        if content.get(field):
            return f'{field} is not allowed'
    return None


def proxy_check(name: str, content: dict) -> str | None:
    """Today's NewProxy checks, then whether this registration may hold the name; None lets it through."""
    if (content.get('user') or {}).get('user'):
        return 'set no user in the tunnel config'
    if content.get('proxy_type') not in ('http', 'https'):
        return 'only http proxies are allowed'
    if content.get('proxy_name') != name:
        return f'the proxy must be named {name}'
    if content.get('subdomain') != name:
        return f'this key serves only {name}.{DOMAIN}'
    if content.get('custom_domains'):
        return 'custom domains are not allowed'
    reason = shared_route_fields(content)
    if reason is not None:
        return reason
    return register_route(name, content)


def client_id_reason(name: str, kind: str, client_id: str, meta_client) -> str | None:
    """R1.3, R5.1: a client id names this link and matches its session's key kind.

    An empty client id is a today's tunnel: only a link-key session without metas.client.
    """
    if not client_id:
        if kind == 'link' and not meta_client:
            return None
        return f'this client id is not for {name}'
    match = CLIENT.fullmatch(client_id)
    if (match is None or match.group('link') != name or meta_client != client_id
            or (match.group('kind') == 'visit') != (kind == 'visitor')):
        return f'this client id is not for {name}'
    return None


def malformed_id_reason(name: str, content: dict, metas: dict) -> str | None:
    """I6: a present-but-non-string id refuses; an absent one stays the legacy empty
    string, as actual legacy frpc sends it."""
    if 'client_id' in content and not isinstance(content['client_id'], str):
        return f'this client id is not for {name}'
    if 'client' in metas and not isinstance(metas['client'], str):
        return f'this client id is not for {name}'
    if 'run_id' in content and not isinstance(content['run_id'], str):
        return 'this run id belongs to another client'
    return None


def reserved_run_id(run_id: str, client_id: str) -> bool:
    """A run id no binding's login may use. frps registers a legacy login under its run id, so the edge's name would cut
    off the real edge (R7.5), and a network client's would take that client's id even while it is offline (C3)."""
    return run_id == EDGE_CLIENT or (not client_id and CLIENT.fullmatch(run_id) is not None)


def login_reason(name: str, kind: str, content: dict, metas: dict) -> str | None:
    """R1.3: the client id fits the session; a live run id is this client's own.

    Every non-empty run id is checked, a legacy login too (C1): frps would let it replace
    the live session with that run id. Legacy run ids cannot use the network client-id
    namespace, even while its client is offline (C3).
    """
    reason = malformed_id_reason(name, content, metas)
    if reason is not None:
        return reason
    client_id = content.get('client_id') or ''
    reason = client_id_reason(name, kind, client_id, metas.get('client'))
    if reason is not None:
        return reason
    run_id = content.get('run_id')
    if not isinstance(run_id, str) or not run_id:
        return None
    if reserved_run_id(run_id, client_id) or run_id_recorded_elsewhere(run_id, name):
        return 'this run id belongs to another client'
    return run_id_conflict(run_id, client_id, name)


def malformed_user_reason(content: dict) -> str | None:
    """I6: a present-but-malformed user object refuses before any route lookup,
    straightening or upsert: no row, no generation may move on a bad shape."""
    if 'user' not in content:
        return None
    user = content['user']
    if not isinstance(user, dict):
        return 'relay error: invalid user'
    if 'run_id' in user and not isinstance(user['run_id'], str):
        return 'this run id belongs to another client'
    return None


def offer_reason(name: str, kind: str, content: dict, metas: dict) -> str | None:
    """R5.1: a visitor offers nothing; a peer offers only its two stcp services; the rest
    is the http proxy of today (Task 2). stcp services get no route row and no generation."""
    reason = malformed_user_reason(content)
    if reason is not None:
        return reason
    if kind == 'visitor':
        return 'visitors may not offer services'
    if 'client' in metas and not isinstance(metas['client'], str):
        return f'this client id is not for {name}'
    client_id = metas.get('client') or ''
    reason = client_id_reason(name, kind, client_id, client_id)
    if reason is not None:
        return reason
    return service_offer_reason(name, client_id, content)


def service_offer_reason(name: str, client_id: str, content: dict) -> str | None:
    """A peer client offers only its two stcp services; every other session offers
    the http proxy of today (Task 2)."""
    match = CLIENT.fullmatch(client_id) if client_id else None
    if match is not None and match.group('kind') == 'peer':
        return peer_proxy_reason(name, match.group('m8'), content)
    return proxy_check(name, content)


def peer_proxy_reason(name: str, m8: str, content: dict) -> str | None:
    """R5.1: a peer offers only <name>-<m8>-data and <name>-<m8>-app, stcp with a real
    secret and open to every visitor of the service."""
    proxy_name = content.get('proxy_name')
    label = proxy_name if isinstance(proxy_name, str) else ''
    allowed = {f'{name}-{m8}-{service}' for service in PEER_SERVICES}
    sk = content.get('sk')
    allow_users = content.get('allow_users')
    if (content.get('proxy_type') != 'stcp' or label not in allowed
            or not isinstance(sk, str) or len(sk) < 32
            or allow_users not in (None, [], ['*'])):
        return f'this client may not offer {label}'
    return None


def trace_run_id(op: str, content: dict) -> str:
    user = content.get('user')
    user = user if isinstance(user, dict) else {}
    run_id = content.get('run_id') if op == 'Login' else user.get('run_id')
    return run_id if isinstance(run_id, str) else ''


def trace_client(op: str, content: dict) -> str:
    user = content.get('user')
    user = user if isinstance(user, dict) else {}
    metas = content.get('metas') if op == 'Login' else user.get('metas')
    metas = metas if isinstance(metas, dict) else {}
    if 'edge' in metas:
        return EDGE_CLIENT
    client = metas.get('client')
    return client if isinstance(client, str) and client else 'legacy'


def trace_plugin(op: str, content: dict, result: dict, started: float) -> None:
    """With RELAY_TRACE=1, one JSON line per plugin call: no key, no metas beyond client."""
    if not os.environ.get('RELAY_TRACE'):
        return
    line = {'op': op, 'proxy_name': content.get('proxy_name') or '', 'run_id': trace_run_id(op, content),
            'client': trace_client(op, content), 'ms': round((time.monotonic() - started) * 1000, 1),
            'reject': bool(result.get('reject'))}
    log_line('TRACE ' + json.dumps(line))


_print_lock = threading.Lock()


def log_line(text: str) -> None:
    """One complete line on stdout, written atomically so concurrent relay threads never interleave."""
    with _print_lock:
        sys.stdout.write(text + '\n')
        sys.stdout.flush()


class Window:
    """Counts events per key in a sliding window, in memory."""

    def __init__(self, limit: int, seconds: int):
        self.limit, self.seconds, self.hits, self.lock = limit, seconds, {}, threading.Lock()

    def allow(self, key: str) -> int:
        """0 if allowed (and counted), else seconds to wait."""
        t = time.time()
        with self.lock:
            if len(self.hits) > 50000:
                self.hits = {k: v for k, v in self.hits.items() if v and v[-1] > t - self.seconds}
            recent = [x for x in self.hits.get(key, []) if x > t - self.seconds]
            if len(recent) >= self.limit:
                self.hits[key] = recent
                return int(recent[0] + self.seconds - t) + 1
            recent.append(t)
            self.hits[key] = recent
            return 0


name_checks = Window(CHECKS_PER_IP_MINUTE, 60)
bad_keys = Window(BAD_KEYS_PER_IP_HOUR, 3600)
create_lock = threading.Lock()


def frpc_config(name: str, key: str) -> str:
    return f'''# Hornhoof relay tunnel for https://{name}.{DOMAIN}
# Keep this file secret: it holds the key of the binding.
serverAddr = "{DOMAIN}"
serverPort = 443
loginFailExit = false
log.to = "console"
log.level = "info"
log.disablePrintColor = true
transport.protocol = "wss"
transport.tls.trustedCaFile = "/etc/ssl/certs/ca-certificates.crt"
transport.heartbeatInterval = 30
transport.heartbeatTimeout = 90
metadatas.name = "{name}"
metadatas.key = "{key}"

[[proxies]]
name = "{name}"
type = "http"
subdomain = "{name}"
localIP = "{TARGET_HOST}"
localPort = {TARGET_PORT}
# frps speaks plain http to the tunnel; the visitor came over https.
requestHeaders.set.x-forwarded-proto = "https"
'''


def tunnel_info(name: str, key: str) -> dict:
    return {
        'image': FRPC_IMAGE,
        'configPath': FRPC_CONFIG_PATH,
        'args': ['-c', FRPC_CONFIG_PATH],
        'config': frpc_config(name, key),
        'serverAddr': DOMAIN,
        'serverPort': 443,
        'protocol': 'wss',
        'proxyName': name,
        'subdomain': name,
        'target': f'{TARGET_HOST}:{TARGET_PORT}',
    }


def creation_wait(ip: str, t: int) -> int:
    """0 while this address and everyone together have room in their hourly limits, else seconds to wait."""
    write('DELETE FROM creations WHERE at < ?', (t - 3600,))
    conn = db()
    mine, oldest = conn.execute('SELECT COUNT(*), MIN(at) FROM creations WHERE ip = ?', (ip,)).fetchone()
    if mine >= BIND_PER_IP_HOUR:
        return max(oldest + 3600 - t, 1)
    total = conn.execute('SELECT COUNT(*) FROM creations').fetchone()[0]
    return 600 if total >= BIND_ALL_HOUR else 0


def random_free_name() -> str:
    """A fresh name has no old route, so only check_name can refuse it (R1.5)."""
    while True:
        name = ''.join(secrets.choice(RANDOM_ALPHABET) for _ in range(24))
        if check_name(name) is None:
            return name


def store_new_binding(name: str, ip: str, t: int) -> str:
    """Store the binding and count its creation; the key leaves here once and only its hash stays."""
    key = secrets.token_urlsafe(32)
    write('INSERT INTO bindings (name, key_hash, created_at, created_ip) VALUES (?, ?, ?, ?)',
          (name, key_hash(key), t, ip))
    write('INSERT INTO creations (ip, at) VALUES (?, ?)', (ip, t))
    return key


@contextlib.contextmanager
def transaction():
    """One BEGIN IMMEDIATE..COMMIT block on this thread's connection, holding the one writer throughout.

    It queues for the writer like any write, so its wait draws from the one write budget and raises the same WriteBusy
    (G1). Its statements run through write(). Any failure rolls back; a spent budget refuses instead of waiting.
    """
    conn = db()
    ticket = WriteTicket(write_deadline())
    writer.wait_for_turn(ticket)
    try:
        writer.leave(ticket)
        begin_writing(conn, ticket.deadline)
        _local.inside_transaction = True
        yield
        write('COMMIT', ())
    except BaseException:
        roll_back(conn)
        raise
    finally:
        _local.inside_transaction = False
        writer.hand_back([])


# What belongs to one binding's lifetime and goes with it. The routes row stays: the generation only grows across
# owners, so an old holder's generation can never match a new owner's.
BINDING_LIFETIME_TABLES = ('visitor_keys', 'ping_keys', 'sync')


def release_binding(name: str, expected_hash: str | None = None) -> bool:
    """Drop a binding and everything of its lifetime in one transaction (C2).

    Separate deletes would let a concurrent visitor-key issuer plant a credential for the
    name between them. The HTTP DELETE passes the hash of the key that authorized it: the
    deletes recheck that hash and a currently unblocked binding inside the transaction,
    so a request authorized for an older lifetime cannot drop a new owner's binding
    (stale DELETE) and one in flight when the operator bans the name cannot erase the
    ban (concurrent ban); False then reads as 404. Admin release passes no hash and
    stays operator-authorized.
    """
    with transaction():
        if expected_hash is None:
            for table in BINDING_LIFETIME_TABLES:
                write(f'DELETE FROM {table} WHERE name = ?', (name,))
            write('DELETE FROM bindings WHERE name = ?', (name,))
        else:
            # The guarded release requires the authorizing hash and a currently
            # unblocked binding: a DELETE in flight when the operator bans the
            # name must not erase the ban (C2 concurrent ban).
            for table in BINDING_LIFETIME_TABLES:
                write(f'DELETE FROM {table} WHERE name = ? AND EXISTS '
                      '(SELECT 1 FROM bindings WHERE name = ? AND key_hash = ? AND banned_at IS NULL)',
                      (name, name, expected_hash))
            write('DELETE FROM bindings WHERE name = ? AND key_hash = ? AND banned_at IS NULL',
                  (name, expected_hash))
        return db().execute('SELECT changes()').fetchone()[0] == 1


def unban_binding(name: str) -> None:
    """Lift a ban in one transaction; a placeholder ban row goes with its visitor key."""
    with transaction():
        write('UPDATE bindings SET banned_at = NULL, ban_reason = NULL WHERE name = ?', (name,))
        write('DELETE FROM visitor_keys WHERE name = ? AND EXISTS '
              '(SELECT 1 FROM bindings WHERE name = ? AND key_hash = \'-\')', (name, name))
        write("DELETE FROM bindings WHERE name = ? AND key_hash = '-'", (name,))


def store_visitor_key(name: str, visitor_hash: str, link_hash: str) -> bool:
    """R6.2: store the hash only while the binding with the authorizing key still exists.

    A request authorized before a release or rebind cannot plant a credential for the
    name's next owner (C2): the write re-checks the binding's key hash in the same
    statement, and a failed check changes nothing.
    """
    return write('INSERT INTO visitor_keys (name, key_hash, created_at) '
                 'SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM bindings WHERE name = ? AND key_hash = ?) '
                 'ON CONFLICT(name) DO UPDATE SET key_hash = excluded.key_hash, '
                 'created_at = excluded.created_at',
                 (name, visitor_hash, now(), name, link_hash)) == 1


class KeyRefused(Exception):
    """R6.1: a key change's body the relay will not act on; the store is not touched. Its message goes in the answer, so
    it never holds a key."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def new_link_key(body: object, current_key: str) -> str:
    """R6.1: the key a change ends on: the one the body chose, or with none chosen a new random one.

    A caller that chose its key holds it before it asks, so an answer lost on the way does not lose the link. Only what the
    relay's own keys look like is taken, and anything else raises KeyRefused.
    """
    if not isinstance(body, dict) or not body.keys() <= {'key'}:
        raise KeyRefused('invalid', BAD_KEY_BODY)
    if 'key' not in body:
        return secrets.token_urlsafe(32)
    chosen = body['key']
    if not isinstance(chosen, str) or CHOSEN_KEY.fullmatch(chosen) is None:
        raise KeyRefused('invalid', BAD_KEY_BODY)
    if secrets.compare_digest(chosen.encode(), current_key.encode()):
        raise KeyRefused('same_key', 'The chosen key is the current key.')
    return chosen


def store_link_key(name: str, new_hash: str, link_hash: str) -> bool:
    """R6.1: rotate only the authorizing, unblocked binding, preserving live Ping.

    The hash comparison prevents an in-flight request from changing a later owner's
    key or overwriting another rotation. Retired hashes authorize only Ping from
    frps's already authenticated sessions, tied to this binding's current hash.
    A release deletes them.
    """
    with transaction():
        write('UPDATE bindings SET key_hash = ? WHERE name = ? AND key_hash = ? AND banned_at IS NULL',
              (new_hash, name, link_hash))
        if db().execute('SELECT changes()').fetchone()[0] != 1:
            return False
        retain_ping_keys(name, new_hash, link_hash)
        return True


def retain_ping_keys(name: str, new_hash: str, link_hash: str) -> None:
    """Keep prior login hashes usable only for heartbeats in this binding lifetime.

    Both statements run in the key rotation's transaction. No retired credential
    becomes a public API credential or authorizes a Login or registration.
    """
    write('UPDATE ping_keys SET link_hash = ? WHERE name = ? AND link_hash = ?',
          (new_hash, name, link_hash))
    write('INSERT INTO ping_keys (name, key_hash, link_hash) VALUES (?, ?, ?) '
          'ON CONFLICT(name, key_hash) DO UPDATE SET link_hash = excluded.link_hash',
          (name, link_hash, new_hash))


def ping_key_matches(name: str | None, key: object) -> bool:
    """A retired link hash serves only this still-bound, unblocked lifetime's Ping."""
    if not isinstance(key, str) or not key:
        return False
    row = db().execute('SELECT 1 FROM ping_keys AS p JOIN bindings AS b '
                       'ON b.name = p.name AND b.key_hash = p.link_hash '
                       'WHERE p.name = ? AND p.key_hash = ? AND b.banned_at IS NULL',
                       (name, key_hash(key))).fetchone()
    return row is not None


def visitor_hash_matches(name: str, visitor: str) -> bool:
    """R6.2: the visitor key matches only while it is the one stored, compared in constant time."""
    row = db().execute('SELECT key_hash FROM visitor_keys WHERE name = ?', (name,)).fetchone()
    return row is not None and hmac.compare_digest(row[0], key_hash(visitor))


def binding_state(name: str):
    """The bindings row for name, or the refusal: no binding, or blocked."""
    row = db().execute('SELECT key_hash, banned_at FROM bindings WHERE name = ?', (name,)).fetchone()
    if row is None:
        return f'no binding {name} with this key'
    if row[1]:
        return f'{name}.{DOMAIN} is blocked'
    return row


def link_key_matches(stored_hash: str, key: object) -> bool:
    return isinstance(key, str) and bool(key) and hmac.compare_digest(stored_hash, key_hash(key))


def key_kind(name: str, metas: dict, row: tuple) -> str | None:
    """'link' when the link key matches, 'visitor' when only the visitor key does."""
    key = metas.get('key')
    if link_key_matches(row[0], key):
        return 'link'
    visitor = metas.get('visitor')
    if key is None and isinstance(visitor, str) and visitor and visitor_hash_matches(name, visitor):
        return 'visitor'
    return None


def authenticate(metas: dict) -> tuple[str | None, str | None, str | None]:
    """(name, kind, refusal): kind is 'link' with the link key, 'visitor' with the visitor key.

    The binding check is as before; a login with no metas.key may match the stored
    visitor key instead (R6.2).
    """
    name = metas.get('name')
    if not isinstance(name, str) or not name:
        return None, None, 'this tunnel has no Hornhoof relay binding (metadatas.name and metadatas.key)'
    state = binding_state(name)
    if isinstance(state, str):
        return name, None, state
    kind = key_kind(name, metas, state)
    if kind is None:
        return name, None, f'no binding {name} with this key'
    return name, kind, None


_seen = {}


def touch(name: str) -> None:
    t = now()
    if t - _seen.get(name, 0) <= 600:
        return
    write('UPDATE bindings SET last_seen = ? WHERE name = ?', (t, name))
    _seen[name] = t


def plugin(op: str, content: dict) -> dict:
    """One plugin call gets one 1 s budget; a spent budget refuses the op, fail closed (Review Focus 3)."""
    call_state.end = time.monotonic() + PLUGIN_CALL_S
    try:
        return plugin_decide(op, content)
    except WriteBusy:
        return {'reject': True, 'reject_reason': 'relay error: busy'}
    finally:
        call_state.end = None


def call_metas(op: str, content: dict) -> dict:
    """The login metas of a plugin call: top level for Login, under user otherwise.

    A malformed user object yields no metas (I6): the call refuses as
    unauthenticated instead of crashing on the bad shape.
    """
    if op == 'Login':
        metas = content.get('metas')
    else:
        user = content.get('user')
        metas = user.get('metas') if isinstance(user, dict) else None
    return metas if isinstance(metas, dict) else {}


def authenticate_call(op: str, metas: dict) -> tuple[str | None, str | None, str | None]:
    """Live sessions retain their heartbeat after rotation; all other ops need the current key."""
    name, kind, reason = authenticate(metas)
    if op == 'Ping' and reason is not None and ping_key_matches(name, metas.get('key')):
        return name, 'link', None
    return name, kind, reason


def edge_token_matches(token: object) -> bool:
    """R7.5: the edge's token, compared in constant time; with no token set, nothing matches."""
    if not EDGE_TOKEN or not isinstance(token, str) or LONE_SURROGATE.search(token):
        return False
    return hmac.compare_digest(token.encode(), EDGE_TOKEN.encode())


def edge_proxy_reason(content: dict) -> str | None:
    """R7.5: the edge offers one proxy, the catch-all behind hornhoof.org, shared with no one. It gets no routes row."""
    if (content.get('proxy_name') != EDGE_CLIENT or content.get('proxy_type') != 'https'
            or content.get('custom_domains') != EDGE_DOMAINS or content.get('subdomain')):
        return 'the edge offers only its own proxy'
    return shared_route_fields(content)


def edge_reason(op: str, content: dict, metas: dict) -> str | None:
    """R7.5: a session that names itself the edge passes on its token alone, never on a binding's checks."""
    if not edge_token_matches(metas['edge']):
        return EDGE_REFUSED
    if op == 'Login' and content.get('client_id') != EDGE_CLIENT:
        return EDGE_REFUSED
    return edge_proxy_reason(content) if op == 'NewProxy' else None


def peer_service_link(proxy_name: str) -> str | None:
    """The link of a peer's service <link>-<m8>-<service>, by CLIENT's rule for the machine that offers it."""
    machine, _, service = proxy_name.rpartition('-')
    match = CLIENT.fullmatch(f'{machine}-peer') if service in PEER_SERVICES else None
    return match.group('link') if match else None


def connection_link(proxy_name: object, proxy_type: object) -> str | None:
    """The link a new connection is for; None for anything that is neither a company's https proxy nor a service."""
    if not isinstance(proxy_name, str):
        return None
    if proxy_type == 'https':
        return proxy_name
    return peer_service_link(proxy_name) if proxy_type == 'stcp' else None


def link_refusal(link: str, key: object) -> str | None:
    """R7.4: why this link takes no new connection. frps holds each new connection on this answer, so that a crowd can
    wait on it (Review Focus 5): one read by the primary key, which under WAL waits for no commit, and never a write. A
    tunnel of a changed key adds one more such read (R6.1).

    The name alone would not do: the proxy may have outlived its binding, and under a new one its visitors would reach the
    old owner's machine. frps sends the key its owner logged in with, and that binding is gone, so this reads as freed.
    """
    row = db().execute('SELECT banned_at, key_hash FROM bindings WHERE name = ?', (link,)).fetchone()
    if row is None:
        return 'freed'
    if row[0]:
        return 'blocked'
    return None if link_key_matches(row[1], key) or ping_key_matches(link, key) else 'freed'


def new_user_conn_reason(content: dict, metas: dict) -> str | None:
    """R7.4: a new connection goes on only to the edge, on its token, or to a link still bound, not blocked, and bound
    when its owner logged in."""
    proxy_name = content.get('proxy_name')
    if proxy_name == EDGE_CLIENT:
        return None if edge_token_matches(metas.get('edge')) else EDGE_REFUSED
    link = connection_link(proxy_name, content.get('proxy_type'))
    return 'not a link' if link is None else link_refusal(link, metas.get('key'))


def plugin_answer(reason: str | None) -> dict:
    return {'reject': False, 'unchange': True} if reason is None else {'reject': True, 'reject_reason': reason}


def plugin_decide(op: str, content: dict) -> dict:
    """Authenticate the session, then the op's own rule; a refusal rejects, else the call passes and is marked seen.

    A NewProxy is marked seen before its rule, so that its registration is the call's last write: a later one could
    still refuse a registration already on disk.
    """
    metas = call_metas(op, content)
    if op == 'NewUserConn':
        return plugin_answer(new_user_conn_reason(content, metas))
    if 'edge' in metas:
        return plugin_answer(edge_reason(op, content, metas))
    name, kind, reason = authenticate_call(op, metas)
    if reason is None and op == 'Login':
        reason = login_reason(name, kind, content, metas)
    elif reason is None and op == 'NewProxy':
        touch(name)
        reason = offer_reason(name, kind, content, metas)
    if reason is None and op != 'NewProxy':
        touch(name)
    return plugin_answer(reason)


class RelayServer(ThreadingHTTPServer):
    # frps keeps two connections to the relay and opens one more for each plugin call beyond those, so that a crowd of
    # visitors is as many new connections at once. Past this queue the kernel drops one, and the visitor waits for its retry.
    request_queue_size = 1024

    def process_request_thread(self, request, client_address) -> None:
        """A connection is a thread and has a SQLite connection of its own, which ends with it."""
        try:
            super().process_request_thread(request, client_address)
        finally:
            close_db()


class Handler(BaseHTTPRequestHandler):
    server_version = 'hornhoof-relay'
    sys_version = ''
    protocol_version = 'HTTP/1.1'
    # An answer is two writes, its headers and its body. Under Nagle's rule the body would wait for the ACK of the headers,
    # which the receiver delays by 40 ms, and frps holds a visitor's new connection on this answer.
    disable_nagle_algorithm = True

    def log_message(self, fmt, *args):
        pass

    def handle_one_request(self):
        """A busy store answers 503 instead of dropping the connection mid-request."""
        self.body_read = False
        try:
            super().handle_one_request()
        except WriteBusy:
            self.error(503, 'busy', 'The relay store is busy, try again.', {'Retry-After': '1'})
        except FrpsUnknown:
            self.error(503, 'unknown', 'The relay cannot tell whether the route is live.')

    def client_ip(self) -> str:
        fwd = self.headers.get('X-Forwarded-For')
        return fwd.split(',')[0].strip() if fwd else self.client_address[0]

    def send_json(self, status: int, body=None, headers=None) -> None:
        data = b'' if body is None else json.dumps(body).encode()
        self.send_response(status)
        if self.request_bytes_may_remain():
            # send_header also ends the connection after this answer. The header tells Caddy not to reuse it.
            self.send_header('Connection', 'close')
        if body is not None:
            self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def request_bytes_may_remain(self) -> bool:
        """Whether this request can leave bytes on the connection, which would be read as the next request.

        Such a request would come from 127.0.0.1 with no X-Forwarded-For, which handle_plugin and client_ip
        trust, so no route may leave one. Transfer-Encoding is never decoded, so its body is never read.
        """
        if 'Transfer-Encoding' in self.headers:
            return True
        return not self.body_read and declared_body_length(self.headers) != 0

    def error(self, status: int, code: str, message: str, headers=None) -> None:
        self.send_json(status, {'error': code, 'message': message}, headers)

    def read_json(self):
        """The request's JSON, or ValueError for a body it cannot read in full, so that no route acts on one."""
        length = declared_body_length(self.headers)
        if 'Transfer-Encoding' in self.headers or length is None or length > MAX_BODY:
            raise ValueError('the body cannot be read')
        raw = self.rfile.read(length) if length else b''
        if len(raw) < length:
            # read() returns short without raising when the client hangs up mid-body.
            raise ValueError('the body was cut short')
        self.body_read = True
        return json.loads(raw) if raw.strip() else {}

    def path_parts(self):
        return [p for p in self.path.split('?', 1)[0].split('/') if p]

    def bearer_key(self) -> str:
        auth = self.headers.get('Authorization') or ''
        return auth[7:].strip() if auth.lower().startswith('bearer ') else ''

    def wrong_key(self, ip: str):
        """The 401 for a bad key, counted like DELETE; 429 once an address passes 30 bad keys in an hour."""
        wait = bad_keys.allow(ip)
        if wait:
            return self.error(429, 'rate_limited', 'Too many wrong keys, try again later.', {'Retry-After': str(wait)})
        return self.error(401, 'unauthorized', 'Send the binding key as Authorization: Bearer <key>.')

    def do_GET(self):
        parts = self.path_parts()
        if parts[:3] == ['api', 'v1', 'names'] and len(parts) == 4:
            return self.name_answer(parts[3].lower())
        if parts[:3] == ['api', 'v1', 'links'] and len(parts) == 5 and parts[4] == 'route':
            return self.route_answer(parts[3].lower())
        if parts == ['api', 'v1', 'health']:
            return self.health_answer()
        self.error(404, 'not_found', 'Not found.')

    def name_answer(self, name: str):
        wait = name_checks.allow(self.client_ip())
        if wait:
            return self.error(429, 'rate_limited', 'Too many checks, try again later.', {'Retry-After': str(wait)})
        reason = requested_name_reason(name)
        body = {'name': name, 'free': reason is None}
        if reason:
            body['reason'] = reason
        return self.send_json(200, body)

    def authorize_link(self, name: str) -> bool:
        """Authenticate link API calls with the same 404 and wrong-key rate limit as route."""
        row = db().execute('SELECT key_hash FROM bindings WHERE name = ?', (name,)).fetchone()
        if row is None:
            self.error(404, 'not_found', f'There is no binding {name}.')
            return False
        key = self.bearer_key()
        if not key or not hmac.compare_digest(row[0], key_hash(key)):
            self.wrong_key(self.client_ip())
            return False
        return True

    def route_answer(self, name: str) -> None:
        """GET /api/v1/links/<name>/route: who holds the name (R2.1), never a guess (R2.3)."""
        if not self.authorize_link(name):
            return
        try:
            return self.send_json(200, route_of(name))
        except (FrpsUnknown, WriteBusy):
            return self.error(503, 'unknown', 'The relay cannot tell whether the route is live.')

    def sync_answer(self, name: str) -> None:
        """R2.4: accept a validated sync record only from the live route's holder."""
        if not self.authorize_link(name):
            return
        if (self.headers.get('Content-Type') or '').split(';')[0].strip().lower() != 'application/json':
            return self.error(415, 'unsupported_media_type', 'Send the body as application/json.')
        try:
            body = self.read_json()
        except ValueError:
            return self.error(400, 'invalid', 'The body is not valid JSON.')
        if not valid_sync_body(body):
            return self.error(400, 'invalid', 'Send client, generation, state, copy and epoch.')
        try:
            conflict, record = set_sync(name, body, key_hash(self.bearer_key()))
        except FrpsUnknown:
            return self.error(503, 'unknown', 'The relay cannot tell whether the route is live.')
        if conflict is not None:
            return self.send_json(409, {'error': conflict})
        return self.send_json(200, {'sync': record})

    def visitor_key_answer(self, name: str) -> None:
        """R6.2: hand out a new visitor key, replacing the one before; the relay stores its
        hash only and never logs or answers with the key again. The store lands only while
        the binding with the authorizing key still exists (C2)."""
        self.key_answer(name, visitor=True)

    def key_answer(self, name: str, visitor: bool = False) -> None:
        """R6.1, R6.2: hand out a key once, committing its hash before answering. A link's owner may choose its key
        (new_link_key); a visitor key is always the relay's own, whatever the body says.

        The body is read before the commit: the answer can be the only copy of the key, and closing a
        connection over unread bytes can reset it, which would leave the company with no key.
        """
        if not self.authorize_link(name):
            return
        current_key = self.bearer_key()
        try:
            body = self.read_json()
            new_key = secrets.token_urlsafe(32) if visitor else new_link_key(body, current_key)
        except KeyRefused as refused:
            return self.error(400, refused.code, str(refused))
        except ValueError:
            return self.error(400, 'invalid', 'The body is not valid JSON.')
        field, store, label = (('visitorKey', store_visitor_key, 'visitor') if visitor
                               else ('key', store_link_key, 'link'))
        if not store(name, key_hash(new_key), key_hash(current_key)):
            return self.error(404, 'not_found', f'There is no binding {name}.')
        log_line(f'new {label} key for {name}')
        self.send_json(200, {field: new_key})

    def health_answer(self):
        """GET /api/v1/health (R4.1): 200 only while frps takes logins, else 503; never a guess."""
        if frps_ok():
            return self.send_json(200, {'ok': True, 'frps': True, 'relayStarted': relay_started(),
                                        'passthrough': _frps['passthrough']})
        return self.send_json(503, {'ok': False, 'frps': False})

    def handle_plugin(self):
        # frps only: Caddy never routes /frp/ here and always adds X-Forwarded-For.
        if self.headers.get('X-Forwarded-For') or self.client_address[0] != '127.0.0.1':
            return self.error(403, 'forbidden', 'Forbidden.')
        op, content, err = self.plugin_request()
        if err is not None:
            return self.send_json(200, {'reject': True, 'reject_reason': err})
        started = time.monotonic()
        try:
            result = plugin(op, content)
        except Exception as e:  # never let a bad plugin call through
            result = {'reject': True, 'reject_reason': f'relay error: {type(e).__name__}'}
        trace_plugin(op, content, result, started)
        return self.send_json(200, result)

    def plugin_request(self) -> tuple[str, dict, str | None]:
        """Parse the plugin body into (op, content, error reason)."""
        try:
            req = self.read_json()
            if not isinstance(req, dict):
                raise TypeError('plugin request is not an object')
            content = req.get('content')
            if not isinstance(content, dict):
                content = {}
            return req.get('op', ''), content, None
        except Exception as e:
            return '', {}, f'relay error: {type(e).__name__}'

    def do_POST(self) -> None:
        parts = self.path_parts()
        if parts == ['frp', 'handler']:
            return self.handle_plugin()
        if parts == ['api', 'v1', 'bindings']:
            return self.create_binding()
        if parts[:3] == ['api', 'v1', 'links'] and len(parts) == 5:
            answer = {'sync': self.sync_answer, 'visitor-key': self.visitor_key_answer,
                      'key': self.key_answer}.get(parts[4])
            if answer is not None:
                return answer(parts[3].lower())
        self.error(404, 'not_found', 'Not found.')

    def binding_body(self) -> dict | None:
        """The request's JSON object with a usable name field, or None once its refusal went out."""
        if (self.headers.get('Content-Type') or '').split(';')[0].strip().lower() != 'application/json':
            self.error(415, 'unsupported_media_type', 'Send the body as application/json.')
            return None
        try:
            body = self.read_json()
        except (ValueError, json.JSONDecodeError):
            self.error(400, 'invalid', 'The body is not valid JSON.')
            return None
        if not isinstance(body, dict):
            self.error(400, 'invalid', 'The body must be a JSON object.')
            return None
        name = body.get('name')
        if name is not None and (not isinstance(name, str) or name == ''):
            self.error(400, 'invalid', 'name must be a non-empty string, or left out for a random one.')
            return None
        return body

    def name_to_bind(self, requested: str | None) -> str | None:
        """The name this binding gets, or None once its refusal went out; only a requested name can be refused."""
        if requested is None:
            return random_free_name()
        name = requested.lower()
        reason = requested_name_reason(name)
        if reason == 'invalid':
            self.error(400, 'invalid', 'Use lowercase letters, digits and hyphens, 1-63 characters, '
                                       'no hyphen at either end and none in the 3rd and 4th place.')
            return None
        if reason:
            self.error(409, reason, f'{name}.{DOMAIN} is {reason}.')
            return None
        return name

    def create_binding(self):
        """POST /api/v1/bindings: one lock holds the limits, the name and the store together."""
        body = self.binding_body()
        if body is None:
            return
        ip = self.client_ip()
        with create_lock:
            t = now()
            wait = creation_wait(ip, t)
            if wait:
                return self.error(429, 'rate_limited', 'Too many new links from this address, try again later.',
                                  {'Retry-After': str(wait)})
            name = self.name_to_bind(body.get('name'))
            if name is None:
                return
            key = store_new_binding(name, ip, t)
        log_line(f'bound {name} for {ip}')
        self.send_json(201, {'name': name, 'url': f'https://{name}.{DOMAIN}', 'key': key,
                             'tunnel': tunnel_info(name, key)})

    def do_DELETE(self):
        parts = self.path_parts()
        if not (parts[:3] == ['api', 'v1', 'bindings'] and len(parts) == 4):
            return self.error(404, 'not_found', 'Not found.')
        name = parts[3].lower()
        row = db().execute('SELECT key_hash, banned_at FROM bindings WHERE name = ?', (name,)).fetchone()
        if row is None:
            return self.error(404, 'not_found', f'There is no binding {name}.')
        key = self.bearer_key()
        if not key or not hmac.compare_digest(row[0], key_hash(key)):
            return self.wrong_key(self.client_ip())
        if row[1]:
            return self.error(403, 'blocked', f'{name}.{DOMAIN} is blocked and cannot be released.')
        if not release_binding(name, row[0]):
            return self.error(404, 'not_found', f'There is no binding {name}.')
        log_line(f'released {name} for {self.client_ip()}')
        self.send_json(204)


# What a ban prints last when frps must restart, which hornhoof-relay acts on. frp 0.71.1 has no call that closes one
# proxy's open connections, so cutting one name's means every link's.
RESTART_FRPS = 'restart frps'
CUT = '--cut'


def admin_list() -> int:
    for r in db().execute('SELECT name, created_at, created_ip, last_seen, banned_at, ban_reason FROM bindings '
                          'ORDER BY created_at'):
        seen = time.strftime('%Y-%m-%d %H:%M', time.gmtime(r[3])) if r[3] else 'never'
        ban = f'  BLOCKED: {r[5]}' if r[4] else ''
        print(f'{r[0]}  created {time.strftime("%Y-%m-%d %H:%M", time.gmtime(r[1]))} from {r[2]}  seen {seen}{ban}')
    return 0


def admin_banned_caddy() -> int:
    hosts = [f'{r[0]}.{DOMAIN}' for r in db().execute('SELECT name FROM bindings WHERE banned_at IS NOT NULL')]
    print('# Generated by hornhoof-relay from blocked bindings. Do not edit.')
    if hosts:
        print(f'@blocked host {" ".join(hosts)}\nhandle @blocked {{\n\troot * /var/www/hornhoof-pages\n\trewrite * /410.html\n'
              f'\tfile_server {{\n\t\tstatus 410\n\t}}\n}}')
    return 0


def admin_add(name: str) -> int:
    """Operator-made binding, no rate limit. Prints {name, key} as JSON once; keep it secret.

    Like the public API it waits for a freed name's old route (R1.5): an http-mode tunnel gets no NewUserConn to stop it, so
    a new owner's name would still send its visitors to the old owner's machine.
    """
    try:
        reason = requested_name_reason(name)
    except FrpsUnknown:
        reason = 'the relay cannot tell whether its old route is gone, nothing changed'
    if reason:
        print(f'{name}: {reason}', file=sys.stderr)
        return 1
    key = secrets.token_urlsafe(32)
    write('INSERT INTO bindings (name, key_hash, created_at, created_ip) VALUES (?, ?, ?, ?)',
          (name, key_hash(key), now(), 'operator'))
    print(json.dumps({'name': name, 'key': key}))
    return 0


def store_ban(name: str, reason: str) -> None:
    if db().execute('SELECT 1 FROM bindings WHERE name = ?', (name,)).fetchone():
        write('UPDATE bindings SET banned_at = ?, ban_reason = ? WHERE name = ?', (now(), reason, name))
    else:  # block a name nobody holds, so nobody can take it
        write('INSERT INTO bindings (name, key_hash, created_at, created_ip, banned_at, ban_reason) '
              'VALUES (?, ?, ?, ?, ?, ?)', (name, '-', now(), 'operator', now(), reason))


def admin_usage() -> int:
    print(f'usage: relay.py admin list | add <name> | ban <name> [reason] [{CUT}] | unban <name> | release <name> | banned-caddy',
          file=sys.stderr)
    return 2


def admin_ban(args: list[str]) -> int:
    """R7.4: refuses the name's new connections at once. Only the ban's last line can ask for a restart.

    The option may stand anywhere, so it goes before the name is read, and what is read must be able to be a name: a slip
    must not block a word and leave the name it meant live."""
    words = [word for word in args if word != CUT]
    if not words:
        return admin_usage()
    name = words[0].lower()
    if not label_valid(name):
        print(f'{name}: invalid', file=sys.stderr)
        return 1
    store_ban(name, ' '.join(words[1:]) or 'blocked by the relay operator')
    print(f'ban {name}: done')
    if len(words) != len(args):
        print(RESTART_FRPS)
    return 0


def admin_unban(name: str, _words: list[str]) -> int:
    unban_binding(name)
    print(f'unban {name}: done')
    return 0


def admin_release(name: str, _words: list[str]) -> int:
    release_binding(name)
    print(f'release {name}: done')
    return 0


ADMIN_REPORTS = {'list': admin_list, 'banned-caddy': admin_banned_caddy}
ADMIN_CHANGES = {'unban': admin_unban, 'release': admin_release}


def admin(args) -> int:
    init_db()
    cmd = args[0] if args else 'list'
    if cmd in ADMIN_REPORTS:
        return ADMIN_REPORTS[cmd]()
    if cmd == 'add' and len(args) == 2:
        return admin_add(args[1].lower())
    if cmd == 'ban':
        return admin_ban(args[1:])
    if cmd in ADMIN_CHANGES and len(args) >= 2:
        return ADMIN_CHANGES[cmd](args[1].lower(), args[2:])
    return admin_usage()


def run_admin(args) -> int:
    """`relay.py admin`: a store busy past a write's budget is one plain line and a failure, which stops hornhoof-relay
    before its next step."""
    try:
        return admin(args)
    except WriteBusy:
        print('the relay store is busy, nothing changed, try again', file=sys.stderr)
        return 1


def main() -> int:
    if sys.argv[1:2] == ['admin']:
        return run_admin(sys.argv[2:])
    init_db()
    threading.Thread(target=watch_frps, name='frps-watcher', daemon=True).start()
    threading.Thread(target=watch_passthrough, name='https-port-watcher', daemon=True).start()
    server = RelayServer(LISTEN, Handler)
    server.daemon_threads = True
    print(f'hornhoof-relay listening on {LISTEN[0]}:{LISTEN[1]}', flush=True)
    server.serve_forever()
    return 0


if __name__ == '__main__':
    sys.exit(main())
