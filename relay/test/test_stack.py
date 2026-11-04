"""What the harness owes every test that starts a Stack: that it starts, and that a failure to start says why."""

import os
import socket
import tempfile
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch

if __package__:
    from . import harness
else:
    import harness


class StackStart(unittest.TestCase):

    def setUp(self) -> None:
        self.tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-stack-'))

    def test_the_echo_cannot_draw_a_port_the_stack_has_yet_to_start(self) -> None:
        # A run lost frps to "bind: address already in use" on its vhost port. The ports a Stack picks stay free until
        # their owners start, and bind(0) may hand out any free port, so this stands for the draw that run was unlucky in.
        stack = harness.Stack(self.tmp)

        class UnluckyDraw(ThreadingHTTPServer):
            def __init__(self, address: tuple, handler: type) -> None:
                super().__init__((address[0], address[1] or stack.vhost_port), handler)

        with patch.object(harness, 'ThreadingHTTPServer', UnluckyDraw), stack:
            self.assertIsNone(stack.frps.process.poll(), stack.frps.log())

    def test_a_process_that_loses_its_port_is_told_who_holds_it(self) -> None:
        stack = harness.Stack(self.tmp)
        with socket.socket() as holder:
            holder.bind(('127.0.0.1', stack.vhost_port))
            holder.listen()
            with self.assertRaises(RuntimeError) as failure:
                stack.__enter__()
        self.assertIn(f'port {stack.vhost_port} is held by pid {os.getpid()}', str(failure.exception))


if __name__ == '__main__':
    unittest.main()
