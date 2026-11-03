"""Facts about frp 0.71.1 that later relay changes depend on."""

import http.client
import tempfile
import time
import unittest

if __package__:
    from .harness import Stack, _wait
else:
    from harness import Stack, _wait


class FrpFactsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-frp-facts-'))
        self.stack = self.enterContext(Stack(self.tmp))
        self.binding = self.stack.bind('acme')

    def test_fact_proxy_name_is_unique(self):
        first = self.stack.client('acme', self.binding['key'])
        self.assertTrue(first.started('acme'), first.log())
        second = self.stack.client('acme', self.binding['key'])
        self.assertFalse(second.started('acme', within=2), second.log())
        self.assertIn('proxy [acme] already exists', second.log())
        first.stop()
        started = time.monotonic()
        self.assertTrue(second.started('acme', within=40), second.log())
        delay = time.monotonic() - started
        print(f'proxy-name retry after first stopped: {delay:.2f} s', flush=True)
        self.assertLessEqual(delay, 40)

    def test_fact_dashboard_shows_the_route(self):
        path = '/api/proxy/http/acme'
        self.assertEqual(self.stack.dash(path)[0], 404)
        first = self.stack.client('acme', self.binding['key'], client='acme-3f2a9c1b-link')
        self.assertTrue(first.started('acme'), first.log())
        status, route = self.stack.dash(path)
        self.assertEqual(status, 200)
        self.assertEqual(route['status'], 'online')
        self.assertEqual(route['clientID'], 'acme-3f2a9c1b-link')
        first.stop()
        self.assertTrue(_wait(lambda: self.stack.dash(path)[1].get('status') == 'offline', 5))
        status, route = self.stack.dash(path)
        self.assertEqual(status, 200)
        self.assertEqual(route['status'], 'offline')
        self.assertEqual(route['clientID'], 'acme-3f2a9c1b-link')

        legacy = self.stack.client('acme', self.binding['key'])
        self.assertTrue(legacy.started('acme'), legacy.log())
        status, route = self.stack.dash(path)
        self.assertEqual(status, 200)
        self.assertEqual(route['status'], 'online')
        self.assertRegex(route['clientID'], r'^[0-9a-f]{16,}$')

        connection = http.client.HTTPConnection('127.0.0.1', self.stack.dash_port, timeout=2)
        try:
            connection.request('GET', '/healthz')
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 200)
        finally:
            connection.close()

    def test_fact_client_id_is_unique(self):
        client_id = 'acme-3f2a9c1b-peer'
        first = self.stack.client(
            'acme', self.binding['key'], settings='network', client=client_id, proxies='',
        )
        self.assertTrue(_wait(lambda: 'login to server success' in first.log(), 15), first.log())
        first.pause()
        second = self.stack.client(
            'acme', self.binding['key'], settings='network', client=client_id, proxies='',
        )
        self.assertTrue(_wait(lambda: 'is already online' in second.log(), 15), second.log())
        self.assertNotIn('login to server success', second.log())
        # Today's server has its own keepalive defaults. Task 3 tightens the eviction bound.
        self.assertTrue(
            _wait(lambda: 'client exit success' in self.stack.frps.log(), 120),
            self.stack.frps.log(),
        )
        dropped = time.monotonic()
        self.assertTrue(_wait(lambda: 'login to server success' in second.log(), 60), second.log())
        delay = time.monotonic() - dropped
        print(f'client-id retry after silent client dropped: {delay:.2f} s', flush=True)
        self.assertLessEqual(delay, 60)


if __name__ == '__main__':
    unittest.main()
