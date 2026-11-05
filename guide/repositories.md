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

## Does GitHub have to test a commit again?

Not after Hornhoof has. Name the repository's full test command, the one that runs every test, on the repository's settings or with `set_repository`.

When a test run of exactly this command ends, Hornhoof puts a commit status called `hornhoof/tests` on the commit that run pinned: `success` when it passed, `failure` when it did not. It stays on that commit even when the branch has moved on. A run of one file, or of any other command, marks nothing.

A GitHub workflow can read this status and skip its own tests on a commit that has `success`. Hornhoof's own image build does.

The token needs the right to write commit statuses: **Commit statuses: Read and write** on a fine-grained token, `repo:status` on a classic one. Without it, or when GitHub does not answer, the task's log and the run's result say so and what to give the token. The run stays passed, and GitHub tests that commit itself.

A command that splits the tests with `{part}` must also say how many parts there are with `{parts}`. Otherwise one part could pass for all of them, so Hornhoof refuses it.

## Where does an agent keep its copy of the code?

Each agent gets its own clone, in its own folder on the node, before its first turn. It keeps the clone between turns, and works in a branch per task.

Nodes from 0.5.0 on take turns with a repository. An older node keeps them waiting until it is updated.

[Back to the guide](README.md)
