# Security

Hornhoof is built so that your company stays yours. It runs on your own machines, its agents work in locked boxes there, and only people your company invites can sign in. This page says exactly how, and how to tell us if you find a hole.

## Your company lives on your machines

- There is no Hornhoof cloud and no account with us. The server, its database and its files run in Docker on your own computers.
- The company's database sits on up to three of your machines: one leads, and the others keep full copies. Copies go only to machines of the CEO and of people who see the whole company.
- No single machine is the company. If the leading machine stops, an up-to-date copy takes over within about a minute, under the same link.
- Every 6 hours and before each update, the leading machine makes a backup, signs it and encrypts it. Up to three other company machines keep the latest two and cannot open them. Only the machines that hold the data, and the recovery file the CEO saves in Company settings, can. A restore checks that a machine holding the data signed the backup. The copy saved before an update also stays on the server unencrypted, as the server holds the database anyway. A machine's owner can untick "Keep company backups".
- A machine that only does work keeps no copy of the database, only those sealed backups when its owner allows them.
- Your machines talk to each other over encrypted connections, and each one proves who it is with a certificate from the company's own authority. The port they talk on takes only machines with such a certificate.
- Hornhoof looks for new builds at GitHub's container registry, anonymously, as `docker pull` does. An update runs exactly the images it checked, by their digests. It saves the database first, and goes back to the old build by itself if the new one does not answer.
- The web app loads nothing from other sites. Its scripts and fonts come from your own server.

## Agents work in locked boxes

- On each machine, every plan runs in a Docker container of its own. The company's API keys run in the server's built-in node, which is a container too.
- No folder of your computer is put into these containers, and none of them gets the Docker socket. An agent sees its container, not your computer.
- The containers drop every Linux capability but the few needed to run agents as another user, and nothing inside them can gain new privileges.
- Inside its container, an agent runs as a user of its own. It cannot read the node's key or change the programs the node starts.
- The built-in node is not on the database's network, so no agent there can reach the database.
- Tests and other work on lent machines run in a fresh folder, as a user that reaches neither the node's key nor the agents' folders. The folder is removed afterwards.

## Sign-ins and keys

- You sign in to each plan yourself, on your own machine. The sign-in is sealed to your machines: Hornhoof stores it so that the server and the copies of the company cannot open it, and only your own machines can. An Antigravity sign-in stays on the machine it was made on. A personal plan's work goes only to its owner's machines.
- Before anything leaves a machine, the node puts `[hidden]` in place of its own key, the plans' tokens, API keys and repository tokens, in terminals and in every output.
- API keys, repository tokens and the link's key are stored encrypted with AES-256-GCM, under the secret in your `.env`. Passwords are stored as scrypt hashes. Sessions, invite links, install commands and the keys nodes connect with are kept only as SHA-256 hashes.
- The command that connects a machine works once, for 24 hours. When the orchestrator makes one, it shows on the CEO's screen and in the orchestrator's tool answer, and the saved conversation keeps its code hidden. No other agent gets it.
- "Disconnect" on a machine's card takes its keys away at once, so a lost or stolen machine can no longer reach the company.

## People see only what they are given

- Until a company is set up, only the setup link from the server's own log can set it up.
- Failed sign-ins are capped, and the counts survive a restart: 10 in 15 minutes for one email from one address, 50 in an hour for one email, and 30 in an hour from one address across all emails (an IPv6 address counts with its /64).
- Session cookies cannot be read by scripts on the page, and travel only over https when Hornhoof is on https. On the hornhoof.org link the cookie's name starts with `__Host-`, so no page under another link can set or replace it. A session from before that change moves to the new name once, on its next visit.
- A change, or a terminal connection, that comes from another site's page is refused, even with your cookie.
- Each person sees only the departments they are given.
- Only the owner of a plan types into its agents' terminals. Everyone else who reaches the employee watches.
- The orchestrator changes people, access, plans, machines, repositories, the public link and updates in any turn, for whoever asked, an employee too. He always acts as the company's owner, in a turn and between turns, and each change goes through the same check as the CEO's click. What the company does not want him to do goes in its notebook. Paying and signing in the company's name wait for a person, and deleting for good waits for the CEO's yes.
- The orchestrator's database tool runs as Hornhoof itself: it reads and changes every table, every column and the schema. The head of Operations only reads, and never sees passwords, tokens or keys, nor the tables of sign-ins, invites and install commands.
- Every machine lends its power to the company's pool by default, and agents still work only inside their boxes there. Root on a machine goes to agents only while access to it is open, for one day at most: to the orchestrator, or to every agent when it is open for all of them. A machine that holds its owner's key opens only with that owner's signature, so nobody else can open it, the CEO included. The server's own machine opens without one while it holds no owner key. While access is open, the orchestrator works there in any turn of his and between turns. Another agent never works there in a turn whose last words came from a person other than the CEO, the CEO delegate or the machine's owner, or from someone Hornhoof cannot name. The server's own machine is the exception for the orchestrator: his shell runs inside Hornhoof itself, which can open that machine, so he can reach root there even while access is closed. Run the server on a machine you are ready to trust him with, and keep other work on other machines.

## The hornhoof.org link

The link, like `https://acme.hornhoof.org`, lets people open your company from anywhere without opening anything on your router.

- It is optional. Untick "Open Hornhoof on the internet" at setup, or remove the link in Settings, and people open Hornhoof only from your own network.
- Your server opens the tunnel itself, over an encrypted connection to hornhoof.org whose certificate it checks.
- The tunnel ends in the keeper, a container next to the app, which passes its traffic to the Hornhoof app only, never to anything else on your network, whatever hornhoof.org asks for.
- hornhoof.org has no accounts and holds none of your company's data. For each link it keeps only the name, a hash of its key, when and from which address the link was made, and when its tunnel was last seen. For a company on several machines it also keeps which machine holds the link, and one flag that says whether the company's copy is up to date.
- The browser's https connection ends at your own machine. hornhoof.org reads only the name being reached from the start of each connection, passes the encrypted bytes on through that company's tunnel, and keeps no copy. Your machine gets the link's certificate from Let's Encrypt itself, accepting Let's Encrypt's Subscriber Agreement for the company, and renews it on its own. If hornhoof.org stops passing connections through unread, or the certificate cannot be renewed in time, the link keeps working with its https ending at hornhoof.org, and Share access says so. A company on an older Hornhoof is served that way until it updates. If you want no one in between at all, use your own domain with your own TLS, as [the install guide](guide/install.md#how-do-people-open-it-from-other-computers) shows.
- A link's name is public: every certificate goes into public Certificate Transparency logs. Before sign-in, the link tells nothing about the company (not its name, its people or its version), and it asks search engines not to list it.
- To stop your machine getting its own certificate, put `ACME_DIRECTORY=off` in the `.env` file next to `compose.yaml` and run `docker compose up -d app` there. The link then runs with its https ending at hornhoof.org, as before.
- Traffic between your machines that goes through hornhoof.org is encrypted from one machine to the other, so hornhoof.org sees only encrypted bytes.
- hornhoof.org decides nothing for your company. A link points to one machine at a time, and that tells two machines which of them leads. A company with no public link keeps a hidden name there for that alone. Three or more machines that are always on choose the leader by vote among themselves.

## What you decide

- Who sees the whole company. Those people see everything, and so do the orchestrator and anyone with access to Operations, whose head reads the database.
- Which plan a department uses. Agents on one plan share its sign-in and can read each other's folders, so work that must stay apart gets a plan of its own.
- What a repository token may do. It goes to the machines that run the department's agents and tests, so a fine-grained token for one repository is best.
- Which AI makers you use. Agents send their prompts and code to those makers, as the programs do outside Hornhoof.

Keep `.env` and the recovery file like passwords: the secret in `.env` opens the stored keys, and the recovery file opens the backups.

## Report a vulnerability

Report it privately on GitHub, not in a public issue: open the repository's **Security** tab and click **Report a vulnerability**. Only the maintainers see the report.

Tell us:

- what an attacker can do, and what they need first (an account, a connected machine, a link);
- the steps to show it, as short as you can make them;
- the version: the build under Versions in the account menu, or the commit you run;
- whether it touches the server, the web app, a node, the installer or the relay at hornhoof.org.

We aim to answer within a week, agree on a fix and a date with you, and name you in the fix unless you ask us not to.

You are welcome to test all of this as hard as you like on your own install.

## Which versions

Only the latest build on `main` gets security fixes. Update from the banner in Hornhoof, or run the install line again.
