# The link on the internet

> In short: Hornhoof can give your company a link like `https://acme.hornhoof.org`, so people open it from anywhere. Nothing has to be opened on your router. Anyone who learns the link reaches the sign-in page, so a random name, which is hard to guess, is the safer choice.

## How do I get a link?

Setup offers the company a public link, like `https://acme.hornhoof.org`. As you type the company's name, it shows the link the company will get, written in Latin letters.

- You can write another name, or take a long random one with "Random name".
- Hornhoof tells you at once whether the name is free.
- The link is on unless you untick "Open Hornhoof on the internet". Then Hornhoof stays on your own computer and network, and you can open the link later under Company settings.

## What changes once there is a link?

Invite links and the commands for new machines use it. Hornhoof still opens at its own address as well.

## Who can reach it?

Anyone who learns the link reaches the sign-in page. A name like the company's own is easy to guess, so only the company's sign-ins protect what is inside. A random name is hard to guess.

## What does hornhoof.org see?

hornhoof.org only passes the traffic on and has no accounts of its own. A small tunnel container next to the server keeps the connection to it, so nothing has to be opened on your router. The tunnel waits while the company has no link.

## How do I change or remove the link?

People who see the whole company find the link under Company settings in the account menu. There they can:

- copy it;
- move it to another name;
- remove it.

The orchestrator does the same when the CEO asks him.

When the name changes or the link goes, machines that were connected through it lose the connection. Connect them again under Subscriptions or Machines.

## Keep a link you made before

A link made earlier at hornhoof.org can be kept instead of getting a new one:

1. Stop any other tunnel for that link. hornhoof.org carries one tunnel per link.
2. Put the link's key in a file.
3. Run this next to `compose.yaml`, with the link's name in place of `<name>`:

   ```sh
   docker compose exec -T app node apps/server/dist/cli.js link <name> < key-file
   ```

[Back to the guide](README.md)
