# The orchestrator

> In short: the orchestrator is the main agent, the circle in the middle of the map. Tell him what you want, and he does what the CEO can do in the screens, with the same checks. Orders about people, access, plans, machines, repositories and updates he takes only from the CEO.

## How do I start?

Click the circle in the middle of the map and tell him about the company. He proposes departments on a card, and one click creates them.

![Building the departments](../.github/assets/build.gif)

## What can I ask him to do?

He runs the company the way the CEO does in the screens. So you can just tell him what to do:

- add or remove a department;
- hire, rename or fire an employee;
- switch employees off or on;
- change their models, skills and prompts;
- write to an employee;
- answer what an employee asked, which includes approving or declining a commit;
- rewrite or cancel a task;
- invite people;
- manage subscriptions, machines, updates and the public link.

Each of these goes through the same check as the CEO's click. What is refused to the CEO is refused to him too. For example, nobody can fire the orchestrator or disable the owner.

## Who can give him orders?

He is the CEO's hands. He takes orders about people, access, the public link, subscriptions, machines, repositories and Hornhoof updates only from the CEO.

- Those tools work only in a turn that answers a message of the CEO.
- In a turn an employee, a timer or a task woke, they refuse. He then tells the employee to ask the CEO.

Another person who sees the whole company does these things in the screens.

## What does only he do?

He puts what an employee asks people into plain words. His words are shown above their answer.

## Can he change the database?

Yes, for what no screen reaches, like a stuck row or a wrong field. He reads and changes Hornhoof's database directly, as a database role of his own. That role:

- reaches the rows of every table but sign-ins, invites, install codes and the public link;
- never reaches the columns with passwords, tokens and keys;
- cannot change the tables themselves, and reaches nothing outside the database.

Through the database he cannot change any of these:

- people, or what they reach;
- subscriptions, machines or repositories;
- an employee's kind, role, skills or subscription;
- a head's department;
- a turn, beyond its status.

Those change only through the tools above, with the CEO's checks.

## What can the head of Operations see?

The head of Operations reads the database too, as a role of its own that only reads. It sends a change it needs to the orchestrator as one message, with the SQL and why.

Because Operations reads the whole database, whoever has access to Operations can learn through its head what is in the other departments. Give Operations only to people who may see the whole company.

## What does he do when work goes wrong?

He looks in the database and in the screens first. Then he fixes the cause himself, or gives it to Operations as one task, instead of asking the CEO.

## What stays with people?

- He does not open the live feed, the pictures agents send, terminals, or the sign-in and invite pages.
- He cannot type into an employee's terminal.
- He does not take improvements into work or set them aside. The CEO decides, and he does the ones the CEO gives him.
- When he writes to an employee, his words do not answer what the employee asked people.

The employee's card and window say when the orchestrator did something.

[Back to the guide](README.md)
