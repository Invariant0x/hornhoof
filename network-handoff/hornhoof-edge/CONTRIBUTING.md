# Contributing to Hornhoof Edge

Small fixes and clear bug reports are welcome. For a large change, open an issue first so we can agree on what it should do. Security problems go through [SECURITY.md](SECURITY.md).

## How a change gets in

1. Fork [the repository](https://github.com/Invariant0x/hornhoof-edge) and make a branch from `main` named after the change.
2. Write a failing test first, run it and see it fail, then write the code that makes it pass.
3. Run the checks below.
4. Sign off every commit with `git commit -s`.
5. Open a pull request against `main` and fill in the template. Keep it to one topic.
6. A maintainer reviews the change. Answer review comments with new commits, and do not force-push over a branch under review.
7. A maintainer merges it as one commit with the pull request's title. Your sign-off goes with it.

## Checks before you push

```sh
sh relay/test/frp.sh
python3 -m unittest discover -s relay/test -v
shellcheck relay/setup-relay.sh relay/hornhoof-relay relay/test/frp.sh
```

Use Python 3.12 or newer. The tests run local servers and need no Python packages. The first command downloads the pinned frp binaries and checks their SHA-256.

## Rules for code and words

- Code, comments and documentation are in English, with no em dashes.
- Use only Python's standard library, and keep the relay runnable on Python 3.12.
- Reformat only files you change.
- Put no private value in a change: no server address, private hostname, company link name, key, token, password, certificate or access configuration. Examples use hornhoof.org and documentation addresses.
- `relay/test/test_public.py` checks every file Git would publish. Private values listed in a local `EDGE_PRIVATE_WORDS` file or `~/.hornhoof-edge/private-words` are checked too, without printing them.
- If a change adds to or changes what the relay stores, update the README's list in the same pull request.

## Sign your work

Every commit carries a `Signed-off-by` line. It says that you wrote the change, or have the right to send it, under the [Developer Certificate of Origin](https://developercertificate.org/). Git adds it using the name and email in your settings:

```sh
git commit -s -m "Explain what the change does"
```

The commit message is a plain sentence in English. Leave generated-by and co-author lines out. You answer for every line you send, including work written with an AI agent.

By sending a pull request, you agree that your contribution is published under the [MIT License](LICENSE). Everyone here follows the [code of conduct](CODE_OF_CONDUCT.md).
