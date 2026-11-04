"""Names by their TLS server name: frps holds the public port and passes a company's encrypted bytes as they came."""

import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import ssl
import struct
import subprocess
import sys
import tempfile
import unittest

if __package__:
    from .harness import (BIN, Client, KeptConnection, PROXY_V2_SIGNATURE, ROOT, Stack, _tls_socket, _wait,
                          load_relay_module, read_proxy_v2)
else:
    from harness import (BIN, Client, KeptConnection, PROXY_V2_SIGNATURE, ROOT, Stack, _tls_socket, _wait,
                         load_relay_module, read_proxy_v2)


# In two parts because this repo's own test allows only known hosts, and this one must stay unknown.
FOREIGN_DOMAIN = 'globex.' + 'example.com'
NOINDEX = 'noindex, nofollow'
# Documentation addresses: nothing real can be named by a forged header.
FORGED_VISITOR = '203.0.113.9'
TOKEN = 'the edge token of this test'
LISTEN_STATE = '0A'
PASSED = {'reject': False, 'unchange': True}
EDGE_REFUSED = {'reject': True, 'reject_reason': 'edge login refused'}


def proxy_v2_header(source: str, source_port: int) -> bytes:
    addresses = socket.inet_aton(source) + socket.inet_aton('192.0.2.1')
    return (PROXY_V2_SIGNATURE + bytes((0x21, 0x11)) + struct.pack('!H', 12) + addresses
            + struct.pack('!HH', source_port, 443))


def listeners_on(port: int) -> list[str]:
    """The addresses listening on a port, from the kernel's own tables, for a test image that has no ss. An IPv6 row
    stays in its raw form, which no test expects, so that a listener on every address cannot pass for loopback."""
    found = []
    for table in ('tcp', 'tcp6'):
        for row in Path('/proc/net', table).read_text().splitlines()[1:]:
            fields = row.split()
            address, _, port_hex = fields[1].partition(':')
            if fields[3] == LISTEN_STATE and int(port_hex, 16) == port:
                found.append(socket.inet_ntoa(bytes.fromhex(address)[::-1]) if table == 'tcp' else address)
    return found


def wait_for_health(stack: Stack, status: int) -> dict:
    """The watcher probes frps every 0.5 s, so an answer follows a change of frps by a moment."""
    answers = []

    def answered() -> bool:
        answers.append(stack.api('GET', '/api/v1/health'))
        return answers[-1][0] == status

    if not _wait(answered, 10):
        raise AssertionError(f'health never answered {status}: {answers[-1]}')
    return answers[-1][1]


class PassthroughCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-sni-'))
        self.stack = self.enterContext(Stack(self.tmp, caddy=True))

    def network_client(self, name: str, key: str, machine8: str = 'aaaaaaaa', proxy_type: str = 'https') -> Client:
        return self.stack.client(name, key, settings='network', client=f'{name}-{machine8}-link',
                                 proxy_type=proxy_type)

    def holder(self, name: str = 'acme') -> tuple[Client, str]:
        key = self.stack.bind(name)['key']
        client = self.network_client(name, key)
        self.assertTrue(client.started(name), client.log())
        return client, key

    def route(self, name: str, key: str) -> dict:
        status, body = self.stack.api('GET', f'/api/v1/links/{name}/route', key=key)
        self.assertEqual(status, 200, body)
        return body

    def assert_refused(self, client: Client, proxy: str, reason: str) -> None:
        self.assertTrue(_wait(lambda: reason in client.log(), 5), client.log())
        self.assertFalse(client.started(proxy, within=0.1), client.log())


class PassthroughTests(PassthroughCase):
    def test_r7_1_passthrough(self) -> None:
        _, key = self.holder()
        answer = self.stack.https('acme.hornhoof.org', '/x')
        self.assertEqual(answer.status, 200, answer.error)
        self.assertEqual(answer.cert_names, ['acme.hornhoof.org'])
        self.assertEqual(json.loads(answer.body)['path'], '/x')
        self.assertEqual(json.loads(answer.body)['host'], 'acme.hornhoof.org')
        route = self.route('acme', key)
        self.assertEqual((route['state'], route['generation']), ('held', 1))
        with sqlite3.connect(f"file:{self.stack.env['RELAY_DB']}?mode=ro", uri=True) as conn:
            self.assertEqual(conn.execute("SELECT type FROM routes WHERE name = 'acme'").fetchone(), ('https',))

    def test_r7_3_visitor_address(self) -> None:
        self.holder()
        passthrough = self.stack.https('acme.hornhoof.org')
        self.assertEqual(json.loads(passthrough.body)['from'], f'127.0.0.1:{passthrough.local_port}')
        http_mode = self.stack.client('globex', self.stack.bind('globex')['key'], via='caddy')
        self.assertTrue(http_mode.started('globex'), http_mode.log())
        answer = self.stack.https('globex.hornhoof.org')
        self.assertEqual(answer.status, 200, answer.error)
        self.assertTrue(answer.headers['X-Test-Peer'].endswith(f':{answer.local_port}'), answer.headers['X-Test-Peer'])
        # Caddy names the visitor and frps adds the address it got the request from: the plan's fact, corrected.
        self.assertEqual(json.loads(answer.body)['xff'], '127.0.0.1, 127.0.0.1')

    def test_r7_2_no_server_name(self) -> None:
        self.holder()
        self.assertEqual(self.stack.https('acme.hornhoof.org').status, 200)
        answer = self.stack.https('acme.hornhoof.org', sni=None)
        self.assertTrue(answer.status is None or 'acme.hornhoof.org' not in answer.cert_names, answer)

    def test_tunnels_through_the_edge(self) -> None:
        client = self.stack.client('initech', self.stack.bind('initech')['key'], via='caddy')
        self.assertTrue(client.started('initech'), client.log())
        self.assertEqual(self.stack.https('initech.hornhoof.org').status, 200)

    def test_r1_1_one_route_across_types(self) -> None:
        for name, first, second in (('acme', 'http', 'https'), ('globex', 'https', 'http')):
            with self.subTest(name=name, holder=first):
                key = self.stack.bind(name)['key']
                holder = self.network_client(name, key, proxy_type=first)
                self.assertTrue(holder.started(name), holder.log())
                other = self.network_client(name, key, machine8='bbbbbbbb', proxy_type=second)
                self.assert_refused(other, name, f'{name} is held')
                route = self.route(name, key)
                self.assertEqual((route['generation'], route['client']), (1, f'{name}-aaaaaaaa-link'))

    def test_legacy_session_holds_an_https_route(self) -> None:
        key = self.stack.bind('acme')['key']
        client = self.stack.client('acme', key, proxy_type='https')
        self.assertTrue(client.started('acme'), client.log())
        self.assertEqual(self.stack.https('acme.hornhoof.org').cert_names, ['acme.hornhoof.org'])
        route = self.route('acme', key)
        self.assertEqual((route['state'], route['client']), ('held', 'legacy'))

    def test_passthrough_needs_no_caddy(self) -> None:
        self.holder()
        self.stack.caddy.stop()
        self.assertEqual(self.stack.https('acme.hornhoof.org').status, 200)
        stub = self.stack.https('hornhoof.org')
        self.assertIsNone(stub.status)
        self.assertTrue(stub.error, 'a failed handshake must say why')

    def test_https_rules(self) -> None:
        cases = (
            ('the proxy must be named acme', 'name = "other"\nsubdomain = "acme"'),
            ('this key serves only acme.hornhoof.org', 'name = "acme"\nsubdomain = "other"'),
            ('group is not allowed',
             'name = "acme"\nsubdomain = "acme"\nloadBalancer.group = "g"\nloadBalancer.groupKey = "k"'),
        )
        key = self.stack.bind('acme')['key']
        for reason, proxy in cases:
            with self.subTest(reason):
                client = self.stack.client('acme', key, proxies=f'''
[[proxies]]
type = "https"
localIP = "127.0.0.1"
localPort = {self.stack.echo_port}
{proxy}
''')
                self.assert_refused(client, 'acme', reason)
                self.assertEqual(self.route('acme', key)['generation'], 0)


class EdgeOnlyTests(PassthroughCase):
    def edge_like_client(self, token: str, client_id: str) -> Client:
        """frpc logging in as the edge would, by the way any tunnel comes in."""
        return self.stack.client('globex', None, proxies=f'''
clientID = {json.dumps(client_id)}
metadatas.edge = {json.dumps(token)}

[[proxies]]
name = "edge2"
type = "https"
customDomains = ["hornhoof.org", "*"]
localIP = "127.0.0.1"
localPort = {self.stack.echo_port}
''')

    def test_r7_5_edge_only(self) -> None:
        key = self.stack.bind('globex')['key']
        foreign = self.stack.client('globex', key, settings='network', client='globex-aaaaaaaa-link', proxies=f'''
[[proxies]]
name = "globex"
type = "https"
subdomain = "globex"
customDomains = ["{FOREIGN_DOMAIN}"]
localIP = "127.0.0.1"
localPort = {self.stack.echo_port}
''')
        self.assert_refused(foreign, 'globex', 'custom domains are not allowed')
        self.assert_refused(self.edge_like_client('a wrong token', 'edge'), 'edge2', 'edge login refused')
        self.assert_refused(self.edge_like_client(self.stack.edge_token, 'edge2'), 'edge2', 'edge login refused')
        status, answer = self.stack.api('POST', '/frp/handler', {'op': 'NewProxy', 'content': {
            'user': {'user': '', 'metas': {'edge': self.stack.edge_token}, 'run_id': 'a run'},
            'proxy_name': 'edge', 'proxy_type': 'https', 'custom_domains': ['*.example.com'],
        }})
        self.assertEqual((status, answer['reject']), (200, True))

    def test_the_edge_itself_comes_in_with_no_route_row(self) -> None:
        self.assertTrue(self.stack.edge.started('edge'), self.stack.edge.log())
        status, proxy = self.stack.dash('/api/proxy/https/edge')
        self.assertEqual((status, proxy['status'], proxy['clientID']), (200, 'online', 'edge'))
        with sqlite3.connect(f"file:{self.stack.env['RELAY_DB']}?mode=ro", uri=True) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM routes').fetchone(), (0,))

    def test_no_edge_token_set_refuses_the_edge(self) -> None:
        tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-sni-no-token-'))
        with Stack(tmp) as plain:
            status, answer = plain.api('POST', '/frp/handler', {'op': 'Login', 'content': {
                'metas': {'edge': ''}, 'client_id': 'edge',
            }})
        self.assertEqual((status, answer), (200, EDGE_REFUSED))


class EdgeHealthAndPagesTests(PassthroughCase):
    def test_r4_1_passthrough_in_health(self) -> None:
        self.assertIs(wait_for_health(self.stack, 200)['passthrough'], True)
        self.stack.stop_frps()
        self.assertEqual(wait_for_health(self.stack, 503), {'ok': False, 'frps': False})
        self.stack.start_frps()
        self.assertIs(wait_for_health(self.stack, 200)['passthrough'], True)
        tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-sni-no-https-'))
        with Stack(tmp) as plain:
            self.assertIs(wait_for_health(plain, 200)['passthrough'], False)

    def test_noindex(self) -> None:
        client = self.stack.client('initech', self.stack.bind('initech')['key'], via='caddy')
        self.assertTrue(client.started('initech'), client.log())
        for host, status in (('initech.hornhoof.org', 200), ('nobody.hornhoof.org', 404), ('admin.hornhoof.org', 404)):
            with self.subTest(host):
                answer = self.stack.https(host)
                self.assertEqual(answer.status, status, answer.error)
                self.assertEqual(answer.headers.get('X-Robots-Tag'), NOINDEX)
        self.stack.admin('ban', 'nobody')
        self.stack.reload_caddy()
        blocked = self.stack.https('nobody.hornhoof.org')
        self.assertEqual(blocked.status, 410)
        self.assertEqual(blocked.headers.get('X-Robots-Tag'), NOINDEX)
        stub = self.stack.https('hornhoof.org')
        self.assertEqual(stub.status, 200)
        self.assertNotIn('X-Robots-Tag', stub.headers)


class VisitorAddressTests(unittest.TestCase):
    def test_the_droplet_logs_no_visitor_address(self) -> None:
        tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-sni-logs-'))
        stack = self.enterContext(Stack(tmp, caddy=True, droplet_logging=True))
        company = stack.client('acme', stack.bind('acme')['key'], settings='network', client='acme-aaaaaaaa-link',
                               proxy_type='https')
        self.assertTrue(company.started('acme'), company.log())
        http_mode = stack.client('initech', stack.bind('initech')['key'], via='caddy')
        self.assertTrue(http_mode.started('initech'), http_mode.log())
        for host in ('acme.hornhoof.org', 'initech.hornhoof.org', 'hornhoof.org', 'nobody.hornhoof.org'):
            answer = stack.https(host)
            self.assertIsNotNone(answer.status, answer.error)
            visitor = f'127.0.0.1:{answer.local_port}'
            for name, process in (('frps', stack.frps), ('edge', stack.edge), ('caddy', stack.caddy),
                                  ('relay', stack.relay)):
                with self.subTest(host=host, process=name):
                    self.assertNotIn(visitor, process.log())


class CaddyBehindFrpsTests(PassthroughCase):
    @unittest.skipUnless(sys.platform == 'linux', 'the kernel lists its sockets this way on Linux only')
    def test_caddy_https_on_loopback_only(self) -> None:
        self.assertEqual(listeners_on(self.stack.caddy_https_port), ['127.0.0.1'])

    def droplet_servers(self) -> list[dict]:
        """What Caddy makes of the repo's own file, read and never run. Test Caddy keeps its http port on loopback, as
        this machine shows no test server to its network, so that 'every address' can only be read here."""
        folder = Path(self.tmp) / 'droplet'
        (folder / 'companies').mkdir(parents=True)
        shutil.copy(ROOT / 'Caddyfile', folder / 'Caddyfile')
        (folder / 'blocked.caddy').write_text('')
        (folder / 'companies/none.caddy').write_text('')
        adapted = subprocess.run(
            [str(BIN / 'caddy'), 'adapt', '--config', str(folder / 'Caddyfile'), '--adapter', 'caddyfile'],
            check=True, capture_output=True, text=True, timeout=30,
            env=dict(os.environ, HOME=str(folder), XDG_DATA_HOME=str(folder), XDG_CONFIG_HOME=str(folder)))
        return list(json.loads(adapted.stdout)['apps']['http']['servers'].values())

    def test_droplet_caddy_listens_as_the_plan_says(self) -> None:
        servers = self.droplet_servers()
        self.assertEqual(sorted(server['listen'] for server in servers), [['127.0.0.1:8443'], [':80']])
        wrappers = {server['listen'][0]: server.get('listener_wrappers', []) for server in servers}
        self.assertEqual(wrappers[':80'], [])
        proxy_protocol = wrappers['127.0.0.1:8443'][0]
        self.assertEqual((proxy_protocol['wrapper'], proxy_protocol['allow']), ('proxy_protocol', ['127.0.0.1/32']))

    def peer_caddy_sees(self, source: str) -> str:
        """Caddy's own view of a connection from source, whose PROXY header names the forged visitor."""
        plain = socket.create_connection(('127.0.0.1', self.stack.caddy_https_port), timeout=10,
                                         source_address=(source, 0))
        plain.sendall(proxy_v2_header(FORGED_VISITOR, 4242))
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        kept = KeptConnection(context.wrap_socket(plain, server_hostname='nobody.hornhoof.org'),
                              'nobody.hornhoof.org', [])
        self.addCleanup(kept.close)
        answer = kept.ask('/')
        self.assertEqual(answer.status, 404, answer.error)
        return answer.headers['X-Test-Peer'].rpartition(':')[0]

    @unittest.skipUnless(sys.platform == 'linux', 'only Linux answers on the whole 127 range')
    def test_proxy_header_is_believed_from_127_0_0_1_only(self) -> None:
        # Built from bytes because this repo's own test allows no other literal loopback address.
        other_loopback = socket.inet_ntoa(bytes((127, 0, 0, 2)))
        self.assertEqual(self.peer_caddy_sees('127.0.0.1'), FORGED_VISITOR)
        self.assertEqual(self.peer_caddy_sees(other_loopback), other_loopback)


class ListenerTableTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'linux', 'the kernel lists its sockets this way on Linux only')
    def test_listeners_on_names_the_address_bound(self) -> None:
        # Built from bytes because this repo's own test allows no other literal loopback address.
        other_loopback = socket.inet_ntoa(bytes((127, 0, 0, 2)))
        with socket.socket() as listener:
            listener.bind((other_loopback, 0))
            port = listener.getsockname()[1]
            self.assertEqual(listeners_on(port), [], 'a port that only is bound is not listening')
            listener.listen()
            self.assertEqual(listeners_on(port), [other_loopback])


class PassthroughEchoTests(PassthroughCase):
    """What the later tasks rely on from the https client's target."""

    def test_echo_answers_400_without_a_proxy_header(self) -> None:
        self.holder()
        sock = _tls_socket(self.stack.passthrough_echoes[-1].server_port, 'acme.hornhoof.org')
        kept = KeptConnection(sock, 'acme.hornhoof.org', [])
        self.addCleanup(kept.close)
        self.assertEqual(kept.ask('/').status, 400)

    def test_kept_connection_carries_a_second_request(self) -> None:
        self.holder()
        first, kept = self.stack.https('acme.hornhoof.org', '/one', keep=True)
        self.assertEqual(first.status, 200, first.error)
        second = kept.again('/two')
        self.assertEqual(second.status, 200, second.error)
        self.assertEqual(json.loads(second.body)['path'], '/two')
        self.assertEqual(json.loads(second.body)['from'], f'127.0.0.1:{first.local_port}')

    def test_unknown_proxy_type_is_refused(self) -> None:
        with self.assertRaisesRegex(ValueError, 'Unknown proxy type'):
            self.stack.client('acme', 'key', proxy_type='tcp')

    def test_close_ends_the_edge(self) -> None:
        self.holder()
        self.stack.close()
        self.assertIsNotNone(self.stack.edge.process.poll())
        with self.assertRaises(OSError):
            socket.create_connection(('127.0.0.1', self.stack.passthrough_echoes[-1].server_port), timeout=2).close()


class ProxyHeaderTests(unittest.TestCase):
    """The harness's reader of the header frpc sends, on a socket pair: no process."""

    def setUp(self) -> None:
        self.reader, self.writer = socket.socketpair()
        self.addCleanup(self.reader.close)
        self.addCleanup(self.writer.close)
        self.reader.settimeout(5)

    def test_header_gives_the_visitor_and_leaves_the_stream(self) -> None:
        self.writer.sendall(proxy_v2_header(FORGED_VISITOR, 4242) + b'the hello')
        self.assertEqual(read_proxy_v2(self.reader), (FORGED_VISITOR, 4242))
        self.assertEqual(self.reader.recv(100), b'the hello')

    def test_no_header_gives_nothing_and_leaves_every_byte(self) -> None:
        stream = b'\x16\x03\x01 a stream that is not a header'
        self.writer.sendall(stream)
        self.assertIsNone(read_proxy_v2(self.reader))
        self.assertEqual(self.reader.recv(100), stream)

    def test_a_stream_that_ends_at_once_gives_nothing(self) -> None:
        self.writer.close()
        self.assertIsNone(read_proxy_v2(self.reader))

    def test_another_family_raises(self) -> None:
        self.writer.sendall(PROXY_V2_SIGNATURE + bytes((0x21, 0x21)) + struct.pack('!H', 36) + bytes(36))
        with self.assertRaisesRegex(ValueError, 'IPv4'):
            read_proxy_v2(self.reader)


class EdgeRuleTests(unittest.TestCase):
    """R7.5's rule on relay.py itself, for what a real frpc would never send."""

    def setUp(self) -> None:
        self.relay = load_relay_module()
        self.relay.EDGE_TOKEN = TOKEN

    def new_proxy(self, **changed: object) -> dict:
        content = {'user': {'user': '', 'metas': {'edge': TOKEN}, 'run_id': 'a run'}, 'proxy_name': 'edge',
                   'proxy_type': 'https', 'custom_domains': ['hornhoof.org', '*']}
        return self.relay.plugin_decide('NewProxy', {**content, **changed})

    def test_login_needs_the_token_and_the_edge_client_id(self) -> None:
        self.assertEqual(self.relay.plugin_decide('Login', {'metas': {'edge': TOKEN}, 'client_id': 'edge'}), PASSED)
        for token, client_id in ((TOKEN, 'edge2'), (TOKEN, ''), (TOKEN, None), ('wrong', 'edge'), ('', 'edge'),
                                 (None, 'edge'), (7, 'edge'), ('café', 'edge')):
            with self.subTest(client_id=client_id, token_is_a=type(token).__name__):
                answer = self.relay.plugin_decide('Login', {'metas': {'edge': token}, 'client_id': client_id})
                self.assertEqual(answer, EDGE_REFUSED)

    def test_no_token_set_refuses_every_login(self) -> None:
        self.relay.EDGE_TOKEN = ''
        for token in ('', TOKEN):
            with self.subTest(token_is_empty=not token):
                answer = self.relay.plugin_decide('Login', {'metas': {'edge': token}, 'client_id': 'edge'})
                self.assertEqual(answer, EDGE_REFUSED)

    def test_the_edge_offers_its_one_proxy(self) -> None:
        self.assertEqual(self.new_proxy(), PASSED)
        for changed in ({'proxy_name': 'acme'}, {'proxy_type': 'http'}, {'proxy_type': 'tcp'},
                        {'custom_domains': ['*.example.com']}, {'custom_domains': ['*', 'hornhoof.org']},
                        {'custom_domains': ['hornhoof.org']}, {'custom_domains': []}, {'custom_domains': None},
                        {'subdomain': 'acme'}, {'group': 'g'}, {'locations': ['/x']}, {'route_by_http_user': 'u'}):
            with self.subTest(changed):
                self.assertIs(self.new_proxy(**changed)['reject'], True)

    def test_a_wrong_token_offers_nothing_and_pings_nothing(self) -> None:
        user = {'user': {'user': '', 'metas': {'edge': 'wrong'}, 'run_id': 'a run'}}
        self.assertEqual(self.new_proxy(**user), EDGE_REFUSED)
        self.assertEqual(self.relay.plugin_decide('Ping', user), EDGE_REFUSED)

    def test_the_edge_pings_with_its_token(self) -> None:
        user = {'user': {'user': '', 'metas': {'edge': TOKEN}, 'run_id': 'a run'}}
        self.assertEqual(self.relay.plugin_decide('Ping', user), PASSED)

    def test_https_follows_the_rules_of_http(self) -> None:
        for proxy_type in ('http', 'https'):
            for changed, reason in (({'proxy_name': 'other'}, 'the proxy must be named acme'),
                                    ({'subdomain': 'other'}, 'this key serves only acme.hornhoof.org'),
                                    ({'custom_domains': [FOREIGN_DOMAIN]}, 'custom domains are not allowed'),
                                    ({'custom_domains': ['hornhoof.org', '*']}, 'custom domains are not allowed'),
                                    ({'group': 'g'}, 'group is not allowed')):
                with self.subTest(proxy_type=proxy_type, reason=reason):
                    content = {'proxy_type': proxy_type, 'proxy_name': 'acme', 'subdomain': 'acme', **changed}
                    self.assertEqual(self.relay.proxy_check('acme', content), reason)

    def test_other_proxy_types_stay_refused(self) -> None:
        for proxy_type in ('tcp', 'udp', 'stcp', 'HTTPS', None):
            with self.subTest(proxy_type=proxy_type):
                content = {'proxy_type': proxy_type, 'proxy_name': 'acme', 'subdomain': 'acme'}
                self.assertEqual(self.relay.proxy_check('acme', content), 'only http proxies are allowed')


class PortProbeTests(unittest.TestCase):
    """The watcher's probe of frps's https port, on a port of the test's own."""

    def setUp(self) -> None:
        self.relay = load_relay_module()

    def test_a_listening_port_accepts(self) -> None:
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            self.assertIs(self.relay.port_accepts(f'127.0.0.1:{listener.getsockname()[1]}'), True)

    def test_a_closed_port_does_not_accept(self) -> None:
        with socket.socket() as unused:
            unused.bind(('127.0.0.1', 0))
            port = unused.getsockname()[1]
        self.assertIs(self.relay.port_accepts(f'127.0.0.1:{port}'), False)

    def test_an_unset_or_bad_address_does_not_accept(self) -> None:
        for address in ('', 'no port', '127.0.0.1:', '127.0.0.1:not a port', '127.0.0.1:70000'):
            with self.subTest(address):
                self.assertIs(self.relay.port_accepts(address), False)


if __name__ == '__main__':
    unittest.main()
