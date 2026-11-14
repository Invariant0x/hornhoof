# The link on the internet

> In short: Hornhoof can give your company a link like `https://acme.hornhoof.org`, so people open it from anywhere. Nothing has to be opened on your router. Link names are public, because each certificate is listed in public logs, so Hornhoof starts with a long random name, which does not say whose company it is. You may change it, and the company's sign-ins protect what is inside.

## How do I get a link?

Setup offers the company a public link, like `https://acme.hornhoof.org`. It starts with a long random name.

- You can write another name, or take a new random one with "Random name".
- Hornhoof tells you at once whether the name is free.
- The link is on unless you untick "Open Hornhoof on the internet". Then Hornhoof stays on your own computer and network, and you can open the link later under Company settings.

## What changes once there is a link?

Invite links and the commands for new machines use it. Hornhoof still opens at its own address as well.

## Who can reach it?

Link names are public: every link's certificate is listed in public logs, so anyone can find the name. Before sign-in the link tells nothing about the company, and it asks search engines not to list it. A name you pick may tell whose company this is. A random name does not. Either way, only the company's sign-ins protect what is inside.

## What does hornhoof.org see?

The connection is encrypted to your company's own machine, which gets the link's certificate from Let's Encrypt. So hornhoof.org passes it on unread and sees only the name being reached. While that is not possible, the link falls back to https that ends at hornhoof.org, as Company settings shows. hornhoof.org has no accounts of its own. The keeper, a small container next to the server, keeps the connection to it, so nothing has to be opened on your router. It carries nothing while the company has no link.

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
