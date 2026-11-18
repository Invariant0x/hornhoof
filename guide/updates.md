# Updates

> In short: Hornhoof looks for a new build every 30 minutes and shows a banner with an "Update" button. The updater saves the database first. If the new server does not answer, it puts the old build back by itself.

## How do I know a new version is out?

Hornhoof checks for a newer build every 30 minutes. People who see the whole company get a banner when one is out:

- "Update" moves to it now. If agents are in the middle of their turns, Hornhoof first says how many would stop, and nothing stops until you say yes;
- "Update when agents finish" waits until no agent is working.

Running the install line again updates too.

## Do my other machines find the server after an update?

A server installed by an older version did not write down its computer's name and addresses, and an update by the "Update" button runs inside Docker, where a Mac's own addresses cannot be seen.

- **On Linux** the updater asks Docker what the computer is called and reads its addresses by itself. Nothing to do.
- **On a Mac** run the install line once on that Mac after the update. Until then your other machines reach the server only through its hornhoof.org link, which works but needs the internet. After it they also find the Mac on your own network, so they go on working with each other when the internet is down.

## Why is 0.8.4 not offered on my server?

A server on 0.8.0 to 0.8.3 offers a version only after a check on real Claude, Codex, Kimi and Antigravity that later versions no longer have, so it shows no banner for 0.8.4 and "Update" says it cannot install it. Run the install line once on the server's computer. It moves the server to the latest version, and from then on the banner offers each new one.

## Why does a machine say it is waiting to update?

A planned update does not cut off agents at work. The machine takes no new work, what runs on it finishes, and then it restarts and takes work again by itself. Its card says how many turns are left and until when. You can still write to its agents: their next turn starts after the update, or on another free machine of the same plan.

If the work does not finish in time, nothing stops. The update is put off, the card says when it tries again, and the head of Operations is told.

Each node on the computer goes by itself: one that has no work left restarts at once, whatever the others still wait for. Versions in the account menu says of each node what it waits for and until when.

On the server's own computer, the updater next to the server replaces the nodes. It knows that computer by the `HORNHOOF_HOST_ID` line in `.env`, which `install.sh server` writes; an update through the updater does not.

Every other computer with nodes has a small updater of its own, one for each Hornhoof whose nodes run there, which the install line starts. Every five minutes it asks the server which build its nodes should run. It first moves itself to that build's updater. When a node runs another build, it asks the server to let that node's work end and replaces the node once it is free, so no turn stops. It runs nothing the server sends: what replaces the nodes comes inside its own image, which Hornhoof published, and the server only names the images by their digests. `install.sh --uninstall` removes it with the nodes. When the server goes back to a build from before 0.8.4, the nodes stay where they are until you run the install line on that computer.

A computer set up before 0.8.4 has no such updater yet, and Machines says its nodes are of another build. Run the install line once on that computer: what runs goes on, and from then on its nodes follow the server by themselves.

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

A public link the company took on the new build is not in that saved copy, while its name stays taken at hornhoof.org. So the updater keeps the link's settings next to the copy, in `backups`, and its log names the file. The newest such file stays there even after its copy is deleted.

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
