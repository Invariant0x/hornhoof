"""The relay's existing behavior, through real frps and frpc processes."""

import tempfile
import unittest

if __package__:
    from .harness import Stack
else:
    from harness import Stack


class TodayTests(unittest.TestCase):
    def setUp(self):
        self.tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-relay-'))
        self.stack = self.enterContext(Stack(self.tmp))
        self.binding = self.stack.bind('acme')

    def test_binding_serves_its_name(self):
        client = self.stack.client('acme', self.binding['key'])
        self.assertTrue(client.started('acme'), client.log())
        self.assertEqual(self.stack.get('acme.hornhoof.org'), 200)

    def test_wrong_key_refused(self):
        client = self.stack.client('acme', 'x')
        self.assertFalse(client.started('acme', within=2), client.log())
        self.assertIn('no binding acme with this key', client.log())

    def test_second_copy_refused(self):
        first = self.stack.client('acme', self.binding['key'])
        self.assertTrue(first.started('acme'), first.log())
        second = self.stack.client('acme', self.binding['key'])
        self.assertFalse(second.started('acme', within=2), second.log())
        self.assertEqual(self.stack.get('acme.hornhoof.org'), 200)

    def test_tcp_proxy_refused(self):
        client = self.stack.client('acme', self.binding['key'], proxies='''
[[proxies]]
name = "acme"
type = "tcp"
localIP = "127.0.0.1"
localPort = 1
remotePort = 0
''')
        self.assertFalse(client.started('acme', within=2), client.log())
        self.assertIn('only http proxies are allowed', client.log())


if __name__ == '__main__':
    unittest.main()
