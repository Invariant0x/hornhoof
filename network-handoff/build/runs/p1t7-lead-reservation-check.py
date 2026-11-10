"""Check local reservation invariants using an isolated module and scratch SQLite only."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile

SOURCE = Path('/Users/0x/Projects/hornhoof-edge/relay/relay.py')
before = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
results = []


def module_in(directory):
    spec = importlib.util.spec_from_file_location('reservation_contract_check', SOURCE)
    relay = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(relay)
    relay.DB_PATH = str(Path(directory) / 'fixture.db')
    relay.CADDYFILE = str(SOURCE.parents[1] / 'Caddyfile')
    relay.init_db()
    relay.frps_route = lambda name: ('absent', None, None)
    return relay


with tempfile.TemporaryDirectory(prefix='hornhoof-reservation-state-') as directory:
    relay = module_in(directory)
    try:
        relay.write('INSERT INTO routes (name, generation, client, run_id, type, state, since) '
                    'VALUES (?, ?, ?, ?, ?, ?, ?)',
                    ('acme', 1, 'acme-aaaaaaaa-link', 'fixture-session', 'http', 'pending', relay.now()))
        held = relay.route_of('acme')['state'] == 'held'
        free = relay.requested_name_reason('acme') is None
        print('pending reservation: route held:', held, 'name available:', free)
        results.append(held and not free)
    finally:
        relay.db().close()

with tempfile.TemporaryDirectory(prefix='hornhoof-reservation-owner-') as directory:
    relay = module_in(directory)
    try:
        def bind(key):
            relay.write('INSERT INTO bindings (name, key_hash, created_at) VALUES (?, ?, ?)',
                        ('acme', relay.key_hash(key), relay.now()))

        bind('fixture-old')
        authenticate = relay.authenticate_call

        def change_lifetime_after_authorization(op, metas):
            result = authenticate(op, metas)
            if op == 'NewProxy' and result[2] is None:
                relay.release_binding('acme')
                bind('fixture-new')
            return result

        relay.authenticate_call = change_lifetime_after_authorization
        result = relay.plugin('NewProxy', {
            'user': {'user': '', 'metas': {'name': 'acme', 'key': 'fixture-old',
                                         'client': 'acme-aaaaaaaa-link'},
                     'run_id': 'fixture-session'},
            'proxy_name': 'acme', 'proxy_type': 'http', 'subdomain': 'acme'})
        row = relay.db().execute('SELECT generation FROM routes WHERE name = ?', ('acme',)).fetchone()
        owner = relay.db().execute('SELECT key_hash FROM bindings WHERE name = ?', ('acme',)).fetchone()
        new_owner = owner is not None and owner[0] == relay.key_hash('fixture-new')
        refused = result.get('reject') is True
        print('changed lifetime: new owner retained:', new_owner,
              'stale registration refused:', refused, 'route row created:', row is not None)
        results.append(new_owner and refused and row is None)
    finally:
        relay.db().close()

stable = before == hashlib.sha256(SOURCE.read_bytes()).hexdigest()
print('Production source unchanged:', stable)
assert stable, 'source moved during the local contract check'
assert all(results), 'reservation or binding-lifetime invariant failed'
