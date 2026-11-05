# Updates

> In short: Hornhoof looks for a new build every 30 minutes and shows a banner with an "Update" button. The updater saves the database first. If the new server does not answer, it puts the old build back by itself.

## How do I know a new version is out?

Hornhoof checks for a newer build every 30 minutes. People who see the whole company get a banner when one is out:

- "Update" moves to it now. If agents are in the middle of their turns, Hornhoof first says how many would stop, and nothing stops until you say yes;
- "Update when agents finish" waits until no agent is working.

Running the install line again updates too.

## Why is a new version not offered?

A version reaches machines only after a real node of exactly that build ran Claude, Codex, Kimi and Antigravity: each one got its words, wrote them down, answered and ended its turn the usual way. Until that check is published next to the version's images, Hornhoof shows no banner for it, "Update" says why it cannot install it, and a node that asks for its server's build stays as it is. This holds for security updates too, and for going back to an earlier version with no check of its own. An update that fails still goes back by itself.

How a release goes through the check is in [CONTRIBUTING.md](../CONTRIBUTING.md#releasing-a-version).

## Why does a machine say it is waiting to update?

A planned update does not cut off agents at work. The machine takes no new work, what runs on it finishes, and then it restarts and takes work again by itself. Its card says how many turns are left and until when. You can still write to its agents: their next turn starts after the update, or on another free machine of the same plan.

If the work does not finish in time, nothing stops. The update is put off, the card says when it tries again, and the head of Operations is told.

Each node on the computer goes by itself: one that has no work left restarts at once, whatever the others still wait for. Versions in the account menu says of each node what it waits for and until when.

A plan's node goes this way only when the server knows it runs on the server's own computer, by the `HORNHOOF_HOST_ID` line in `.env`. The install line writes that line; an update through the updater does not. A node the server does not know is not replaced by itself: it goes on working on its build, and Machines says it is of another build. Run the install line once on that computer: what runs goes on, and the updater replaces such a node when its work ends.

The orchestrator and the heads wait for such a node for three minutes at most. After that their next turn goes to another machine of their plan or, when the plan has no other, to the node that waits, whose work runs on. Other agents' turns wait for the update.

## Go back to an earlier build

Versions in the account menu lists the published builds, with the one running now. It goes back to an earlier one the same way.

## What does the updater do?

The updater runs next to the server. It goes through these steps:

1. It downloads exactly the build Hornhoof found, by its digest, and the node and updater images of the same build, by theirs. The old server keeps working meanwhile.
2. It saves the database.
3. It starts exactly these images, with the installer inside the build.
4. If the new server does not answer, it puts back the images that ran before.

`.env` names the images compose starts. So a tag that moves in the registry later changes nothing.

## What happens to the database when it goes back?

When the new build had already changed the database, the database goes back to the saved copy too.

## Take back a public link after an update went back

A public link the company took on the new build is not in that saved copy, while its name stays taken at hornhoof.org. So the updater keeps the link's settings next to the copy, in `backups`, and its log names the file.

To take the link back, on a build that has public links:

1. Put the `key` from that file into a file of its own.
2. Run this next to `compose.yaml`, with the `name` from that file in place of `<name>`:

   ```sh
   docker compose exec -T app node apps/server/dist/cli.js link <name> < key-file
   ```

## What if the updater restarts in the middle?

An updater that restarts in the middle of an update goes on with it.

## My server has no updater

A server installed before the updater existed gets it when you run the install command once more.

[Back to the guide](README.md)
