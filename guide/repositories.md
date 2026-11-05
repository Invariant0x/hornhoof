# Repositories

> In short: a department, or a product inside it, can name the git repository its agents work in. Each agent works in its own copy, in a branch per task. Give it a token for this one repository, because the token travels to the machines that run the agents.

## Give a department a repository

A department, or a product inside it, can name the git repository its agents work in. Inside the department, people who see the whole company set its address, its branch and a token.

A product's repository goes to the agents of that product, instead of the department's.

## How is the token kept?

- It is kept encrypted, and shows only its last four characters.
- It never reaches a command line or the clone's settings.
- git gets it only for the repository's own host. A new address on another host needs a new token.

## Where does the token go?

Each agent's turn carries it to the machine that runs the agent. So it lands on the machines of whoever's subscriptions serve the department. Give it a fine-grained token for this one repository.

Test runs take it along too. [Tests and heavy work on free machines](free-machines.md#where-does-the-repository-token-go-during-a-test-run) says where. The server uses it as well, to read from the repository which commit a branch is at.

## Whose name goes on the commits?

Set a commit author, a name and an email, and every agent commits under that name. Hornhoof sets it in each clone and asks the agents to add no co-author lines.

Without one, each agent's program picks its own.

## Where does an agent keep its copy of the code?

Each agent gets its own clone, in its own folder on the node, before its first turn. It keeps the clone between turns, and works in a branch per task.

Nodes from 0.5.0 on take turns with a repository. An older node keeps them waiting until it is updated.

[Back to the guide](README.md)
