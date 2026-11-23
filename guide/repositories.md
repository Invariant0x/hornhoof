# Repositories

> In short: a department, or a product inside it, can name the git repository its agents work in. Each agent works in its own copy, in a branch per task. Give it a token for this one repository, because the token travels to the machines that run the agents.

## Give a department a repository

A department, or a product inside it, can name the git repository its agents work in. Inside the department, people who see the whole company set its address, its branch and a token.

A product's repository goes to the agents of that product, instead of the department's.

## Why does every department need one?

A repository keeps every version of what is in it. So each department, not only Development, keeps its work there as files: letters, texts, layouts and tables as well as code. When a letter changes, its earlier wording is still there and can be brought back.

A department with no repository hands its work in as a document attached to the task, with no history. When a GitHub key is saved, the orchestrator creates a repository for such a department himself and tells the CEO or the department's owner where it is. Without a key he offers them one and says what it takes.

## Let Hornhoof create the repository

Save a GitHub key, and the orchestrator himself creates a private repository for every department that has none yet, and tells you where it is. Any further one he creates when you ask him to:

- For the whole company, in **Company settings** in the account menu, under **Creating repositories**. People who see the whole company save it.
- For one department, on its screen under **Repositories**. Its owner saves it as well, and it goes first for that department.

Give the GitHub user or organization the repositories go to, and a token that may create repositories there and push to them: a fine-grained token for all repositories of that owner with **Administration** and **Contents** set to **Read and write**, or a classic token with `repo`.

He creates a private repository with a first commit holding a README, and connects it to the department with the same key. A department that has a repository already gets one more only when you ask, as a new product. Without a key he says what is missing.

That key then goes to the machines of the department's agents, as any repository token does, and it reaches every repository of its owner. Save a key for one department when its repositories belong to an owner of their own.

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

## Which branches does Hornhoof remove?

Branches it made for work pile up, so Hornhoof can tidy them by itself. It is off until the person who runs the server sets `HORNHOOF_BRANCH_PRUNE=on`, and the token then needs the right to write contents (**Contents: Read and write** on a fine-grained token, `repo` on a classic one).

- A task's branch (`task-12`, `release-check-12`) is deleted once a turn branch, `main` or a release tag holds its last commit. Nothing is lost: the commits stay in that history.
- The branch of a task that was cancelled, or closed for seven days, and whose last commit no turn, `main` or tag holds, is first copied to `refs/hornhoof/archive/<branch>` and then deleted.
- The 20 newest turn branches stay. An older one is deleted only when a release tag `v…` stands on its last commit.
- It never touches `main`, tags, the branch of an open or paused task, or a branch Hornhoof has no record of making, such as a person's.

It works a batch of 50 changes at a time and stays inside GitHub's request limit, going on after the limit ends. Each deleted or archived branch goes into the log of its task, with its last commit and the reason.

To bring an archived branch back, run in a copy of the repository, with the branch's own name:

```
git fetch origin refs/hornhoof/archive/task-12 && git push origin FETCH_HEAD:refs/heads/task-12
```

To see what it would do first, or to tidy once by hand, run `node apps/server/dist/cli.js branch-prune` on the server: it only lists, as a dry run, until you add `--apply`. `--limit N` bounds the changes for each repository, `--repo TEXT` picks repositories by their address, and `--all-branches` lists the branches it keeps too.

When Hornhoof can write to the repository, finished turnkey work joins its turn branch as one merge commit of its own, `Take in task-12 (#12)`, whose files are exactly those of the commit that was checked. Work a person already fast-forwarded into the turn branch stays as it is.

## Where does an agent keep its copy of the code?

Each agent gets its own clone, in its own folder on the node, before its first turn. It keeps the clone between turns, and works in a branch per task.

Nodes from 0.5.0 on take turns, with a repository or without one. An older node keeps them waiting until it is updated. Nodes with the updater of 0.8.4 and later follow the server to each new version by themselves.

[Back to the guide](README.md)
