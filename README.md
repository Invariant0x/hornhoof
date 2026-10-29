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
docker compose up -d
```

Open http://localhost:8080 and follow the setup: name your company, create your account and connect the chief's subscription.

Keep `.env` safe. `HORNHOOF_SECRET` encrypts the API keys stored in the database, and without it they cannot be read back.

If people will open Hornhoof from other machines, add `PUBLIC_URL=https://your.domain` to `.env`. Invite links use it, and sign-in cookies are marked secure when it starts with `https://`.

## Development

You need Node 22.

```sh
npm install
npm test
```

Run Postgres, then start the server with `DATABASE_URL` and `HORNHOOF_SECRET` set (`npm run dev`) and the web app with `npm run dev -w apps/web`. The web app proxies `/api` to port 8080.
