# Backups

> In short: every 6 hours and before each update Hornhoof makes a backup of the company and encrypts it. The server keeps the latest two, and up to three other machines of the company keep them too, without being able to open them. The CEO saves a recovery file once. With it the company comes back even when its server is lost. Every step here is a click.

## What is in a backup?

The whole database of the company: its departments, employees, tasks, conversations and settings. With it go three settings of the server that the database cannot be used without: the secret that opens the stored keys, the key of the server's own node, and the address of the relay.

A backup is signed by the machine that made it and encrypted. Only two things can open it: a machine that holds the company's data, and the recovery file.

The copy saved just before an update is also kept on the server as it is, unencrypted, in the `backups` folder next to Hornhoof. The server holds the database anyway, so this tells nobody anything new.

## Who keeps the backups?

- The server keeps its latest two.
- Up to three other machines of the company keep the latest two as well. These are machines connected under Machines that have the company's core on them, as every machine connected since has. They hold sealed files they cannot open.
- When one of the company's machines is somewhere else than the server, one place goes to it. A fire or a theft in one room then does not take every copy.
- A machine's owner decides whether it keeps backups: the tick "Keep company backups" is on the machine's card under Machines. Unticked, the machine deletes the ones it holds.

Until the recovery file is saved, backups stay on the server alone. Nobody could open a copy on another machine once the server is gone.

## What is the recovery file?

A small text file that opens every backup made for it. The CEO saves it under Company settings in the account menu, in the part "Backups", with "Save the recovery file". The browser downloads it once. Hornhoof keeps no copy.

- Keep it like a password, and not only on the server: on a USB stick, in a password manager, on another computer.
- While there is no file, the CEO sees a line under the top bar that asks for it.
- Saving a new file is fine at any time. Older files then open only the backups made before it.
- If the company's public link changes, the line asks for a new file. The file names the link, so the machines that are left can find a new server by it.

## How do I restore the company from a backup?

Open Company settings, part "Backups". Each backup shows when it was made, how big it is and which machines hold it. Press "Restore" next to the one you want. Only the CEO can do this.

Hornhoof first says what the restore means:

- The company goes back to how it was at the backup's time.
- Everything after that time stays in the database that is replaced, which is kept on the server. A tick, "Bring back what came after", says whether Hornhoof brings it back by itself. See [What came after a restore](#what-came-after-a-restore) below.
- Machines that joined after that time must be connected again. People who were added after it must be invited again. Hornhoof names them.
- Everyone signs in again afterwards.
- Each machine keeps its access setting. The orchestrator grants employee access again as needed.

A restore never brings back what was taken away since: a person who was disabled stays disabled, a changed password stays changed, and a machine that was disconnected stays out.

While the databases change places, Hornhoof shows the same page as during an update. If the restored company does not start, the server goes back to the database it had, by itself.

Some backups show a line instead of a plain "Restore":

- "Made by a newer Hornhoof. Update first." Update the server, then restore.
- "No machine that holds it is online." Turn on one of the machines named next to it.
- "Add the recovery file it was made for to restore it." Press "Restore" and choose the recovery file. The server cannot open this backup by itself.

## What came after a restore

A restore takes the company back in time, and the database it replaces holds everything the company did since. The tick "Bring back what came after" in the restore's question decides what becomes of that.

With the tick on, as it is unless you take it off, Hornhoof brings that work back right after the restore:

- What the company added since comes back as it was: new tasks, messages, departments, employees.
- What differs is never overwritten. The restored value stays, and both values are listed.
- The orchestrator gets one task with what differs in the work, and settles each difference: keep what is here, or take what was there. He tells the holders of the tasks that changed and reports to you.
- What differs about people, access, plans, machines and protected records waits for you alone, as a card under Tasks, "Waiting for you". Each row shows the value here and the value there. Press "Keep here" or "Take there", for one row or for a whole table.
- Commands that were running stay stopped.

With the tick off, nothing of what came after comes back.

Either way the replaced database is saved as an encrypted backup, listed as "Set aside before a merge", kept for 30 days and then removed from the server. Company settings, part "Backups", shows how far this has got. While the bringing back still runs, "Leave it out" stops it: what that database held after the backup then does not come back, and it stays as a backup for the 30 days.

An update waits until this is done. If you need to update first, leave the database out.

## What if the server itself is lost?

Then the recovery file brings the company back on a new server.

1. Install Hornhoof on a new computer with the install line from the [README](../README.md), and open the setup link it prints.
2. On the first screen choose "Restore from a recovery file" and pick the file.
3. Wait. The company's machines that are still on notice that their server is gone, find the new one and send it the backups they hold. This takes about 15 minutes. They find it by the company's public link, or at the old server's address.
4. If no machine sends one, upload a backup file yourself with "Or upload a backup file".
5. Press "Restore this one" next to a backup. When it is done, sign in as before.

A plan that was signed in on the lost machine is signed in again under Subscriptions, on a machine that is on.

Two things to know about such a restore:

- It cannot tell what was taken away after the backup was made. Look through People and Machines afterwards, and disable or disconnect what should not be there.
- Without a public link, the machines that are left find a new server only at the old server's address.
