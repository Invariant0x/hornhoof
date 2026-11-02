# Updates

> In short: Hornhoof looks for a new build every 30 minutes and shows a banner with an "Update" button. The updater saves the database first. If the new server does not answer, it puts the old build back by itself.

## How do I know a new version is out?

Hornhoof checks for a newer build every 30 minutes. People who see the whole company get a banner when one is out:

- "Update" moves to it now;
- "Update when agents finish" waits until no agent is working.

Running the install line again updates too.

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
