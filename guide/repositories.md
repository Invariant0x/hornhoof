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

Test runs take it along too. [Tests and heavy work on free machines](free-machines.md#where-does-the-repository-token-go-during-a-test-run) says where. The server uses it as well, to read from the repository which commit a branch is at, and to read and start the repository's CI for a release.

## What does a release need from the repository's CI?

A release rests on the repository's GitHub Actions runs of its exact commit, which Hornhoof reads with the repository's token. Every job of every counted run must have finished with success, and a test job (named `test` or `tests`, with or without its matrix, as `test (1)`) that was skipped makes the run red: a skipped test proved nothing. A commit status or the check of another app proves nothing, as anyone who can write to the repository can post one. A repository with no workflow file and no check at all releases with no run. A repository on another host than github.com cannot be released, because Hornhoof reads no CI there.

Only the **full runs of the release workflow** count; a run of any other workflow on the commit is neither proof nor a blocker. A person names the release workflow, by the path of its file, in the repository's settings (**Release workflow**, for example `.github/workflows/release.yml`). Hornhoof never works it out, not from the repository's releases or tags and not from which workflow went green, because anyone who can write to the repository can publish a release or start a workflow. With none named, `release_turn` refuses and says: name the release workflow in the repository settings. The orchestrator names it with `set_repository` and `releaseWorkflow`.

A **full run** is one that ran every test, with nothing narrowing it. The release workflow keeps this contract:

- it starts on `workflow_dispatch` with a yes-or-no input named `full`, which Hornhoof sets when it starts the workflow;
- with `full` set, it runs every test: no status that says tests passed spares them, and no earlier commit's passed tests narrow what runs;
- with `full` set, the title of its run ends with `(full run)`, which a `run-name` writes: `run-name: ${{ github.event_name == 'workflow_dispatch' && format('{0}{1}', github.workflow, inputs.full && ' (full run)' || '') || '' }}`.

A run counts only if it was started by hand and its title ends so: a run of a push or of a pull request, or one by hand without `full`, may have run only the tests a change reached, and proves less. GitHub gives no run's inputs, so the title is what says it.

Pushing a turn branch starts no workflow. Where no full run of the release workflow is on the commit of a release, `release_turn` starts it on the turn branch itself with `full` set, once for each commit. The minute round then records the release when CI is green on that exact commit and tells the head.

The token needs **Actions: Read and write** and **Contents: Read** on a fine-grained token, `repo` on a classic one. Without the right to write Actions, the release is refused and says so.

## Whose name goes on the commits?

Set a commit author, a name and an email, and every agent commits under that name. Hornhoof sets it in each clone and asks the agents to add no co-author lines.

Without one, each agent's program picks its own.

## Does GitHub have to test a commit again?

Not after Hornhoof has. Name the repository's full test command, the one that runs every test, on the repository's settings or with `set_repository`.

When a test run of exactly this command ends, Hornhoof puts a commit status called `hornhoof/tests` on the commit that run pinned: `success` when it passed, `failure` when it did not. It stays on that commit even when the branch has moved on. A run of one file, or of any other command, marks nothing.

A GitHub workflow can read this status and skip its own tests on a commit that has `success`. Hornhoof's own image build does. A release does not rest on such a run: only a full run of the release workflow counts, and a full run reads no status, so it runs every test of a commit that already carries one.

The token needs the right to write commit statuses: **Commit statuses: Read and write** on a fine-grained token, `repo:status` on a classic one. Without it, or when GitHub does not answer, the task's log and the run's result say so and what to give the token. The run stays passed, and GitHub tests that commit itself.

A command that splits the tests with `{part}` must also say how many parts there are with `{parts}`. Otherwise one part could pass for all of them, so Hornhoof refuses it.

## Where does an agent keep its copy of the code?

Each agent gets its own clone, in its own folder on the node, before its first turn. It keeps the clone between turns, and works in a branch per task.

Nodes from 0.5.0 on take turns, with a repository or without one. An older node keeps them waiting until it is updated. Nodes with the updater of 0.8.4 and later follow the server to each new version by themselves.

[Back to the guide](README.md)
