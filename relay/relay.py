#!/usr/bin/env python3
"""Hornhoof relay: hands out <name>.hornhoof.org links and checks every tunnel that frps lets in.

Public API (Caddy sends https://hornhoof.org/api/* here):
  GET    /api/v1/names/{name}      -> 200 {name, free, reason?: taken|reserved|invalid}, 503 if unknown
  POST   /api/v1/bindings          {name?} -> 201 {name, url, key, tunnel}, 409 taken, 503 if unknown
  DELETE /api/v1/bindings/{name}   Authorization: Bearer <key> -> 204 (404 once the name belongs to a new owner)
  GET    /api/v1/links/{name}/route Authorization: Bearer <key> -> 200 {state, client, since, generation, ...}
  POST   /api/v1/links/{name}/sync  Authorization: Bearer <key> {client, generation, state, copy, epoch} -> 200 {sync}
  POST   /api/v1/links/{name}/key   Authorization: Bearer <key> -> 200 {key} (R6.1)
  POST   /api/v1/links/{name}/visitor-key Authorization: Bearer <key> -> 200 {visitorKey} (R6.2)
  GET    /api/v1/health            -> 200 {ok, frps, relayStarted} while frps takes logins, else 503
frps plugin (local only): POST /frp/handler?op=Login|NewProxy|Ping
Admin (as the service user): relay.py admin list|add|ban|unban|release|banned-caddy ...

Standard library only. State: SQLite in /var/lib/hornhoof-relay/relay.db. Keys are stored as SHA-256 hashes.
"""
import base64
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
# A registration frps has not shown yet reads as held for this long (R1.1, R2.1).
PENDING_S = 10
# R3.1 measured with frp 0.71.1: network 20.16/20.46 s, today 20.26 s (2026-11-03).
EVICTION_BOUND_S = 30
# One budget per plugin call: a spent budget refuses the op, fail closed (Review Focus 3).
PLUGIN_CALL_S = 1.0

LABEL = re.compile(r'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
CONTENT_LENGTH = re.compile(r'[0-9]{1,18}')
RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
# A network client's id: <link>-<machine8>-<kind> (R1.3, R1.4, R5.1).
CLIENT = re.compile(r'^(?P<link>[a-z0-9-]{1,63})-(?P<m8>[0-9a-f]{8})-(?P<kind>link|peer|visit)$')
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


def init_db() -> None:
    write('''CREATE TABLE IF NOT EXISTS bindings (
            name TEXT PRIMARY KEY,
            key_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            created_ip TEXT,
            last_seen INTEGER,
            banned_at INTEGER,
            ban_reason TEXT
        )''', ())
    write('CREATE TABLE IF NOT EXISTS creations (ip TEXT NOT NULL, at INTEGER NOT NULL)', ())
    write('CREATE INDEX IF NOT EXISTS creations_at ON creations(at)', ())
    write('''CREATE TABLE IF NOT EXISTS routes (
            name TEXT PRIMARY KEY,
            generation INTEGER NOT NULL,
            client TEXT NOT NULL,
            run_id TEXT NOT NULL,
            type TEXT NOT NULL CHECK (type IN ('http', 'https')),
            state TEXT NOT NULL CHECK (state IN ('pending', 'held', 'empty')),
            since INTEGER NOT NULL
        )''', ())
    write('''CREATE TABLE IF NOT EXISTS sync (
            name TEXT PRIMARY KEY,
            state TEXT NOT NULL CHECK (state IN ('on', 'off')),
            copy TEXT,
            epoch INTEGER NOT NULL,
            generation INTEGER NOT NULL,
            at INTEGER NOT NULL
        )''', ())
    write('''CREATE TABLE IF NOT EXISTS visitor_keys (
            name TEXT PRIMARY KEY,
            key_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )''', ())
    write('''CREATE TABLE IF NOT EXISTS ping_keys (
            name TEXT NOT NULL,
            key_hash TEXT NOT NULL,
            link_hash TEXT NOT NULL,
            PRIMARY KEY (name, key_hash)
        )''', ())


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


def check_name(name: str):
    """None when the name can be bound, else 'invalid', 'reserved' or 'taken'. A banned name counts as reserved."""
    if not LABEL.fullmatch(name) or name[2:4] == '--':
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
_frps = {'ok_at': 0.0, 'back_at': 0}
WATCH_INTERVAL_S = 0.5
# Health answers 200 only while the watcher's last good probe is younger than this.
HEALTH_MAX_AGE_S = 2.0


def frps_answers() -> bool:
    """True when frps's bind port accepts a connection and its dashboard answers /healthz."""
    host, _, port_text = RELAY_FRPS_BIND.rpartition(':')
    try:
        connection = socket.create_connection((host, int(port_text)), timeout=1)
        connection.close()
    except OSError:
        return False
    try:
        status, _ = _dash_get('/healthz', cap=1.0)
    except FrpsUnknown:
        return False
    return status == 200


def watch_frps() -> None:
    """Probe frps forever; keep the last good answer and the recovery after a failure."""
    was_ok = False
    while True:
        if frps_answers():
            t = time.time()
            if not was_ok:
                _frps['back_at'] = t
            _frps['ok_at'] = t
            was_ok = True
        else:
            was_ok = False
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


def name_live(name: str) -> bool:
    """R1.5: a freed name waits for its old route; an unknown dashboard raises."""
    return frps_route(name)[0] == 'online'


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
    """A SQLite write could not take the lock within its budget: refuse the op, never guess."""


def write(sql: str, args: tuple) -> None:
    """The one SQLite write of the plugin and the API.

    SQLite itself retries database is locked for the write's budget (0.8 s, or the plugin
    call's time left, whichever is less); past the budget the write raises WriteBusy and a
    plugin call refuses with 'relay error: busy' (Review Focus 3).
    """
    conn = db()
    left = call_deadline()
    if left is not None and left <= 0:
        raise WriteBusy('plugin call budget spent')
    budget = 0.8 if left is None else min(0.8, left)
    conn.execute(f'PRAGMA busy_timeout = {max(0, int(budget * 1000))}')
    try:
        conn.execute(sql, args)
    except sqlite3.OperationalError as e:
        if 'locked' in str(e):
            raise WriteBusy(f'database is locked for {budget:.2f} s') from None
        raise
    finally:
        conn.execute('PRAGMA busy_timeout = 10000')


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
    elif state == 'pending' and t - row[5] > PENDING_S:
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
    return isinstance(value, str) and 1 <= len(value) <= 100


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
    write('INSERT INTO sync (name, state, copy, epoch, generation, at) '
          'SELECT name, ?, ?, ?, generation, ? FROM routes '
          "WHERE name = ? AND generation = ? AND client = ? AND state = 'held' "
          'AND EXISTS (SELECT 1 FROM bindings WHERE name = ? AND key_hash = ?) '
          'ON CONFLICT(name) DO UPDATE SET state = excluded.state, copy = excluded.copy, '
          'epoch = excluded.epoch, generation = excluded.generation, at = excluded.at '
          'WHERE excluded.epoch > sync.epoch',
          (body['state'], body['copy'], body['epoch'], now(), name, body['generation'], body['client'],
           name, link_hash))
    return db().execute('SELECT changes()').fetchone()[0] == 1


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


def upsert_route(name: str, content: dict, user: dict) -> str | None:
    """Write the pending row for a let-through registration; a refusal when the write cannot land."""
    row = db().execute('SELECT generation FROM routes WHERE name = ?', (name,)).fetchone()
    generation = (row[0] if row else 0) + 1
    metas = user.get('metas') or {}
    try:
        write(
            'INSERT INTO routes (name, generation, client, run_id, type, state, since) VALUES (?, ?, ?, ?, ?, ?, ?) '
            'ON CONFLICT(name) DO UPDATE SET generation = excluded.generation, client = excluded.client, '
            'run_id = excluded.run_id, type = excluded.type, state = excluded.state, since = excluded.since',
            (name, generation, metas.get('client') or 'legacy', user.get('run_id') or '',
             content.get('proxy_type') or 'http', 'pending', now()))
    except WriteBusy:
        return 'relay error: busy'
    except sqlite3.Error:
        return 'relay error: frps does not answer'
    return None


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
    if content.get('proxy_type') != 'http':
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
    if (not client_id and CLIENT.fullmatch(run_id)) or run_id_recorded_elsewhere(run_id, name):
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
    client = metas.get('client') if isinstance(metas, dict) else None
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
    """One BEGIN IMMEDIATE..COMMIT block; every statement, including BEGIN and
    COMMIT, runs through write(), so lock acquisition draws from the one write
    budget and raises the same WriteBusy as a single write (G1). Any failure
    rolls back; a spent budget refuses instead of waiting.
    """
    conn = db()
    write('BEGIN IMMEDIATE', ())
    try:
        yield
        write('COMMIT', ())
    except BaseException:
        if conn.in_transaction:
            try:
                conn.execute('ROLLBACK')
            except sqlite3.Error:
                pass
        raise


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
    write('INSERT INTO visitor_keys (name, key_hash, created_at) '
          'SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM bindings WHERE name = ? AND key_hash = ?) '
          'ON CONFLICT(name) DO UPDATE SET key_hash = excluded.key_hash, '
          'created_at = excluded.created_at',
          (name, visitor_hash, now(), name, link_hash))
    return db().execute('SELECT changes()').fetchone()[0] == 1


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


def key_kind(name: str, metas: dict, row: tuple) -> str | None:
    """'link' when the link key matches, 'visitor' when only the visitor key does."""
    key = metas.get('key')
    if isinstance(key, str) and key and hmac.compare_digest(row[0], key_hash(key)):
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


def plugin_decide(op: str, content: dict) -> dict:
    """Authenticate the session, then the op's own rule; a refusal rejects, else the call passes."""
    metas = call_metas(op, content)
    name, kind, reason = authenticate_call(op, metas)
    if reason is None and op == 'Login':
        reason = login_reason(name, kind, content, metas)
    elif reason is None and op == 'NewProxy':
        reason = offer_reason(name, kind, content, metas)
    if reason is not None:
        return {'reject': True, 'reject_reason': reason}
    touch(name)
    return {'reject': False, 'unchange': True}


class Handler(BaseHTTPRequestHandler):
    server_version = 'hornhoof-relay'
    sys_version = ''
    protocol_version = 'HTTP/1.1'

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
        """R6.1, R6.2: hand out a fresh key once, committing its hash before answering.

        The body is read before the commit: the answer is the only copy of the key, and closing a
        connection over unread bytes can reset it, which would leave the company with no key.
        """
        if not self.authorize_link(name):
            return
        try:
            self.read_json()
        except ValueError:
            return self.error(400, 'invalid', 'The body is not valid JSON.')
        field, store, label = (('visitorKey', store_visitor_key, 'visitor') if visitor
                               else ('key', store_link_key, 'link'))
        new_key = secrets.token_urlsafe(32)
        if not store(name, key_hash(new_key), key_hash(self.bearer_key())):
            return self.error(404, 'not_found', f'There is no binding {name}.')
        log_line(f'new {label} key for {name}')
        self.send_json(200, {field: new_key})

    def health_answer(self):
        """GET /api/v1/health (R4.1): 200 only while frps takes logins, else 503; never a guess."""
        if frps_ok():
            return self.send_json(200, {'ok': True, 'frps': True, 'relayStarted': relay_started()})
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


def admin(args) -> int:
    init_db()
    conn = db()
    cmd = args[0] if args else 'list'
    if cmd == 'list':
        for r in conn.execute('SELECT name, created_at, created_ip, last_seen, banned_at, ban_reason FROM bindings '
                              'ORDER BY created_at'):
            seen = time.strftime('%Y-%m-%d %H:%M', time.gmtime(r[3])) if r[3] else 'never'
            ban = f'  BLOCKED: {r[5]}' if r[4] else ''
            print(f'{r[0]}  created {time.strftime("%Y-%m-%d %H:%M", time.gmtime(r[1]))} from {r[2]}  seen {seen}{ban}')
        return 0
    if cmd == 'banned-caddy':
        hosts = [f'{r[0]}.{DOMAIN}' for r in conn.execute('SELECT name FROM bindings WHERE banned_at IS NOT NULL')]
        print('# Generated by hornhoof-relay from blocked bindings. Do not edit.')
        if hosts:
            print(f'@blocked host {" ".join(hosts)}\nhandle @blocked {{\n\troot * /var/www/hornhoof-pages\n\trewrite * /410.html\n'
                  f'\tfile_server {{\n\t\tstatus 410\n\t}}\n}}')
        return 0
    if cmd == 'add' and len(args) == 2:
        # Operator-made binding, no rate limit. Prints {name, key} as JSON once; keep it secret.
        name = args[1].lower()
        reason = check_name(name)
        if reason:
            print(f'{name}: {reason}', file=sys.stderr)
            return 1
        key = secrets.token_urlsafe(32)
        write('INSERT INTO bindings (name, key_hash, created_at, created_ip) VALUES (?, ?, ?, ?)',
              (name, key_hash(key), now(), 'operator'))
        print(json.dumps({'name': name, 'key': key}))
        return 0
    if cmd in ('ban', 'unban', 'release') and len(args) >= 2:
        name = args[1].lower()
        if cmd == 'ban':
            reason = ' '.join(args[2:]) or 'blocked by the relay operator'
            if conn.execute('SELECT 1 FROM bindings WHERE name = ?', (name,)).fetchone():
                write('UPDATE bindings SET banned_at = ?, ban_reason = ? WHERE name = ?', (now(), reason, name))
            else:  # block a name nobody holds, so nobody can take it
                write('INSERT INTO bindings (name, key_hash, created_at, created_ip, banned_at, ban_reason) '
                      'VALUES (?, ?, ?, ?, ?, ?)', (name, '-', now(), 'operator', now(), reason))
        elif cmd == 'unban':
            unban_binding(name)
        else:
            release_binding(name)
        print(f'{cmd} {name}: done')
        return 0
    print('usage: relay.py admin list | add <name> | ban <name> [reason] | unban <name> | release <name> | banned-caddy',
          file=sys.stderr)
    return 2


def main() -> int:
    if sys.argv[1:2] == ['admin']:
        return admin(sys.argv[2:])
    init_db()
    threading.Thread(target=watch_frps, name='frps-watcher', daemon=True).start()
    server = ThreadingHTTPServer(LISTEN, Handler)
    server.daemon_threads = True
    print(f'hornhoof-relay listening on {LISTEN[0]}:{LISTEN[1]}', flush=True)
    server.serve_forever()
    return 0


if __name__ == '__main__':
    sys.exit(main())
