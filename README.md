# Hornhoof Edge

The relay behind the public links of [Hornhoof](https://github.com/Invariant0x/hornhoof) companies.

## What it does

It gives each company a link like `https://acme.hornhoof.org`. The company's own machine opens a tunnel to the relay, so nothing needs to open on the company's router. A visitor opens the link, and the relay passes the connection through that company's tunnel to its Hornhoof app.

The relay hands out names, checks each tunnel's key, and sends each connection to the company named in its TLS server name.

A company on several machines gives each one its own client id, so two companies can run side by side on one machine and no two machines log in as one. A company's machines also reach each other's services through the relay: a `-peer` machine offers two stcp services, `-data` and `-app`, and another machine of the same link visits them with the link's visitor key and the service's own secret. The relay lets those machines reach each other through it and passes their bytes on as they come; [Hornhoof's security page](https://github.com/Invariant0x/hornhoof/blob/main/SECURITY.md#the-hornhooforg-link) says how the machines encrypt them.

## What it sees

For a company whose link uses https and whose tunnel is up, hornhoof.org sees only encrypted bytes, the name being reached and the visitor's address, which it does not keep. The browser's https connection ends at the company's own machine, with the company's own certificate, and never reaches Caddy. The relay holds no key for that connection and cannot read what passes.

While that company's tunnel is down, during an update, a restart or a network failure, or before it first connects, nothing claims its name, so a visitor's connection falls back to Caddy. Caddy answers under the relay's wildcard certificate, which a browser trusts for that name, with a 404 page, or a 410 page if the name is blocked. To answer, it reads that request, including any cookies the company's app set, and keeps nothing of it.

Caddy speaks only HTTP/1.1, because a browser reuses an HTTP/2 connection for any name its certificate covers, which would bring the requests of a company whose tunnel is up to Caddy as well. A company in http mode does without HTTP/2 until it moves to https.

A company on an older Hornhoof is served the old way until it updates: its https ends at hornhoof.org, under the relay's wildcard certificate. The relay reads each request to find its company, then passes it through that company's tunnel. This includes the contents of requests and answers. It keeps no copy of what passes. This is the behavior [Hornhoof's security page](https://github.com/Invariant0x/hornhoof/blob/main/SECURITY.md#the-hornhooforg-link) describes today.

hornhoof.org itself, its API and the tunnels' way in also end at hornhoof.org, in Caddy.

## What it never does

- Run a company's code.
- Hold a company's data, files or passwords in storage.
- Keep accounts.
- Reach through a tunnel anywhere but where the company's own frpc pointed it. Today that is the Hornhoof app; a `-peer` machine may also offer two stcp services, `<link>-<machine8>-data` and `<link>-<machine8>-app`, to the link's other machines, each opened with the service's own secret. The relay fixes which service names a peer may offer; which ports they connect to on the machine is the company's own frpc setting.
- Keep a copy of the requests and answers it passes.

## What it stores

For each link, the relay keeps:

- its name and a hash of its key;
- when and from which address it was made;
- when its tunnel was last seen;
- whether it is blocked, when it was blocked, and why;
- which client holds its route, with that client's run id, since when, and in which registration (a counter that grows by one at every registration); the route's state (pending, held, empty) and type (http, https). The relay reads whether a route is live from frps itself, so it never answers "empty" for a name it is not sure of;
- its sync record: on or off, the copy's machine, its epoch, the registration it came in and when. Only the live route's holder can set a newer epoch. The relay commits it to SQLite with full synchronization before answering, and keeps it across restarts;
- the hashes of its earlier keys, after a key change, so that a tunnel already logged in keeps its heartbeat. Nothing but a heartbeat can use them;
- a hash of its visitor key, the key a visitor-only client logs in with. The key itself is handed out once and never stored or logged.

Releasing a name deletes its key hashes and its sync record. Its route record stays, so that the registration counter keeps growing for the next owner.

For each address, it also keeps the times of new links made in the last hour, to limit how many it can make. The relay's database is SQLite.

The relay logs each link made or freed with the address it came from. On the server, this log goes to the system journal. frps logs only its errors, because its other lines name each visitor's address. Caddy logs no requests, but its error log names the visitor's address of a request that fails on its way to frps or the relay; a connection to a company whose https tunnel is up never reaches Caddy.

## Run the tests

You need Python 3.12 or newer, Git, curl, tar and openssl, on macOS or Linux. The tests use only Python's standard library. The first run downloads frps and frpc 0.71.1 from their release and checks the archive's SHA-256 before using it, and does the same for Caddy 2.11.8 with its SHA-512.

From this folder:

```sh
sh relay/test/frp.sh
sh relay/test/caddy.sh
python3 -m unittest discover -s relay/test -v
```

The tests start their own relay, frps, frpc, Caddy and small web server on local ports, then stop them. They never connect to the public relay. The publication checks read tracked files and files Git would add, respecting `.gitignore`. If `EDGE_PRIVATE_WORDS` names a file, or `~/.hornhoof-edge/private-words` exists, they also check that none of its private values appears in those files.

## What is where

- `relay/relay.py`: the name API, tunnel checks and operator commands, in one Python file.
- `relay/frps.toml`: frps settings; the server password is a placeholder.
- `relay/edge-frpc.toml`: the server's own frpc, which carries everything that frps does not route to a company on to Caddy. Its token comes from the environment.
- `relay/setup-relay.sh`, `relay/hornhoof-relay` and the service files: server setup and operator commands.
- `Caddyfile`: the web server settings behind frps, the API and tunnel entry points, and the traffic of companies in http mode.
- `pages/`: the page template, build script and fonts. `pages/build.py` builds `www/index.html` and the relay's 404 and 410 pages.
- `relay/test/`: tests and their local server harness. Downloaded binaries stay in the ignored `.bin/` folder.
- `deploy.env.example`: example deployment settings. Real settings, access keys and other private files stay outside this repository.

## License

The code is under the [MIT License](LICENSE). The Onest and Tektur fonts are under [OFL-1.1](pages/fonts/OFL.txt).
