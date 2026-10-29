# Hornhoof

Run your company with a team of AI agents.

Hornhoof is a self-hosted workspace where people and AI agents work together as one company. You set up departments, each one led by an agent, and watch every agent's work live on one map.

The project is in early development. Right now you can set up a company, invite people and see the map. Agents start working in later versions.

## Quick start

You need Docker with Compose.

```sh
git clone https://github.com/Invariant0x/hornhoof.git
cd hornhoof
echo "HORNHOOF_SECRET=$(openssl rand -base64 32)" > .env
echo "NODE_KEY=$(openssl rand -base64 32)" >> .env
docker compose up -d
```

Open http://localhost:8080 and follow the setup: name your company, create your account and connect the chief's subscription.

Keep `.env` safe. `HORNHOOF_SECRET` encrypts the API keys stored in the database, and without it they cannot be read back. `NODE_KEY` lets the built-in node, which runs the company's API keys, connect to Hornhoof.

If people will open Hornhoof from other machines, add `PUBLIC_URL=https://your.domain` to `.env`. Invite links and the node command use it, and sign-in cookies are marked secure when it starts with `https://`. Hornhoof itself serves plain HTTP, so put something that handles TLS in front of it, like Caddy, nginx or a Cloudflare tunnel. Without TLS the browser drops the secure cookie and you stay on the login screen.

Errors go to the container log: `docker compose logs app`.

## Development

You need Node 22.

```sh
npm install
npm test
```

Run Postgres, then start the server with `DATABASE_URL` and `HORNHOOF_SECRET` set (`npm run dev`) and the web app with `npm run dev -w apps/web`. The web app proxies `/api` to port 8080.
