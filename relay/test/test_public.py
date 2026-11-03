"""Keep tracked and untracked publishable files safe, including these tests."""

import ipaddress
import os
from pathlib import Path
import re
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[2]
ALLOWED_HOSTS = {
    'github.com', 'www.github.com', 'developercertificate.org',
    'scripts.sil.org', 'openfontlicense.org', 'www.contributor-covenant.org',
    'example.com',
}
# These are Python names, not hosts. A reviewer approves additions as for ALLOWED_HOSTS.
CODE_NAMES = {'threading.local'}


class PublicTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        names = subprocess.check_output(
            ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT,
        )
        cls.files = {
            name: (ROOT / name).read_bytes().decode('utf-8')
            for raw in names.split(b'\0') if raw
            for name in [os.fsdecode(raw)] if not name.endswith('.woff2')
        }
        if not cls.files:
            raise AssertionError('No publishable files found.')

    def test_project_files(self):
        for name in (
            'LICENSE', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md',
            'CODE_OF_CONDUCT.md', '.github/workflows/tests.yml',
            '.github/workflows/sign-off.yml',
        ):
            self.assertTrue(name in self.files, f'Missing project file: {name}')
        self.assertTrue('Copyright (c) 2026 Ivan Korol' in self.files['LICENSE'],
                        'LICENSE is missing the required copyright')
        for heading in (
            'What it does', 'What it sees', 'What it never does',
            'What it stores', 'Run the tests', 'What is where', 'License',
        ):
            self.assertTrue(re.search(rf'(?m)^## {heading}$', self.files['README.md']) is not None,
                            f'README.md is missing heading: {heading}')
        self.assertTrue('Signed-off-by' in self.files['CONTRIBUTING.md'],
                        'CONTRIBUTING.md is missing sign-off instructions')

    def test_no_ip_address(self):
        allowed = tuple(ipaddress.ip_network(network) for network in (
            '192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24',
        ))
        for name, text in self.files.items():
            for match in re.finditer(r'(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])', text):
                try:
                    address = ipaddress.ip_address(match.group())
                except ValueError:
                    continue
                self.assertTrue(
                    str(address) in {'127.0.0.1', '0.0.0.0'}
                    or any(address in network for network in allowed),
                    f'{name}: IPv4 address at position {match.start()}',
                )

    def test_no_secret(self):
        forbidden = (
            'PRIVATE ' + 'KEY-----', 'BEGIN ' + 'CERTIFICATE',
            'ssh-' + 'ed25519 ', 'ssh-' + 'rsa ', 'ecdsa-' + 'sha2-',
            'Identity' + 'File', 'Host' + 'Name ',
        )
        for name, text in self.files.items():
            for marker in forbidden:
                if marker in text:
                    self.fail(f'{name}: forbidden secret marker at position {text.index(marker)}')

    def test_only_known_hosts(self):
        pattern = r'\b(?:[a-z0-9-]+\.)+(?:org|com|net|io|dev|local|lan|internal|ru|br)\b'
        for name, text in self.files.items():
            for match in re.finditer(pattern, text):
                host = match.group()
                self.assertTrue(
                    host == 'hornhoof.org' or host.endswith('.hornhoof.org')
                    or host in ALLOWED_HOSTS or host in CODE_NAMES,
                    f'{name}: unapproved host at position {match.start()}',
                )

    def test_private_words(self):
        path = Path(os.environ.get('EDGE_PRIVATE_WORDS', '~/.hornhoof-edge/private-words')).expanduser()
        if not path.exists():
            print('private-words: none here, skipped', flush=True)
            return
        for number, word in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
            if not word:
                continue
            for name, text in self.files.items():
                # Never include the word itself in a failure, even through an assertion helper.
                if word.casefold() in text.casefold():
                    self.fail(f'{name}: matches private-words line {number}')

    def test_english_no_em_dash(self):
        for name, text in self.files.items():
            if re.search(r'[\u2014\u0400-\u052f\u2de0-\u2dff\ua640-\ua69f]', text):
                self.fail(f'{name}: non-English text or forbidden dash')


if __name__ == '__main__':
    unittest.main()
