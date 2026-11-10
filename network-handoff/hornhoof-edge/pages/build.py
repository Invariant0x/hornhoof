#!/usr/bin/env python3
"""Builds the relay's pages from page.html, with the two fonts (OFL-1.1, from @fontsource) inlined, since frps
serves its 404 page as one file. Run it after editing page.html; setup.sh and setup-relay.sh install the results."""
import base64
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent

PAGES = {
    # The hornhoof.org stub.
    ROOT / 'www' / 'index.html': {
        'TITLE': 'Hornhoof',
        'CODE': '',
        'WIDE': ' wide',
        'HEAD': 'A company of AI agents on your own machines',
        'TEXT': 'Start yours: run this command in a terminal on a Mac or a Linux machine. It installs Docker if it is missing, starts Hornhoof and gives you a link to set it up, where you pick your company\'s address.',
        'EXTRA': (HERE / 'start.html').read_text().rstrip('\n'),
        'FOOT': 'Self-hosted. Each company lives at its own address.',
    },
    # A company name with no live tunnel (frps) and the reserved names (Caddy).
    ROOT / 'relay' / '404.html': {
        'TITLE': 'No company here - Hornhoof',
        'WIDE': '',
        'EXTRA': '',
        'CODE': '<span class="code"><b>404</b></span>',
        'HEAD': 'No company here',
        'TEXT': 'This address has no Hornhoof, or its server is offline right now.',
        'FOOT': '<a href="https://hornhoof.org/">hornhoof.org</a>',
    },
    # A name the relay's operator blocked.
    ROOT / 'relay' / '410.html': {
        'TITLE': 'Address blocked - Hornhoof',
        'WIDE': '',
        'EXTRA': '',
        'CODE': '<span class="code"><b>410</b></span>',
        'HEAD': 'Address blocked',
        'TEXT': 'This address was closed and no longer opens a company.',
        'FOOT': '<a href="https://hornhoof.org/">hornhoof.org</a>',
    },
}


def font(name: str) -> str:
    return base64.b64encode((HERE / 'fonts' / name).read_bytes()).decode()


def main() -> None:
    template = (HERE / 'page.html').read_text()
    fonts = {'TEKTUR': font('tektur-latin-600-normal.woff2'), 'ONEST': font('onest-latin-400-normal.woff2')}
    for path, words in PAGES.items():
        page = template
        for key, value in {**fonts, **words}.items():
            page = page.replace('{{' + key + '}}', value)
        assert '{{' not in page, path
        path.write_text(page)
        print(f'{path.relative_to(ROOT)}: {len(page)} bytes')


if __name__ == '__main__':
    main()
