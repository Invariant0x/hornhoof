# Security

Hornhoof Edge carries the public links of Hornhoof companies. What it sees and what it stores are listed in the [README](README.md#what-it-stores).

## In scope

- `relay/relay.py`, including the name API and frps plugin.
- The frps and Caddy settings.
- The setup script and operator commands.
- The pages the relay serves.

## Report a vulnerability

Report it privately on [the repository](https://github.com/Invariant0x/hornhoof-edge), rather than in a public issue: open the **Security** tab and click **Report a vulnerability**. Only the maintainers see the report.

Tell us:

- what an attacker can do, and what they need first, such as a link or its key;
- the steps to show it, as short as you can make them;
- the commit you run and the frp version;
- whether it touches the relay API, tunnel checks, frps, Caddy, setup or the pages.

We aim to answer within a week, agree on a fix and a date with you, and name you in the fix unless you ask us not to.

You are welcome to test this on your own local relay.

## Which versions

Only the latest code on `main` gets security fixes.
