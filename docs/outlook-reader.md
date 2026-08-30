# The Outlook reader — a note for whoever is asking

*SCDB Cockpit, an Obsidian plugin. This page exists to be handed to an IT or security
colleague who has seen Obsidian start PowerShell and wants to know why.*

## In one paragraph

The plugin keeps a record of correspondence relating to data requests. One optional feature
reads message headers and bodies from **the Outlook session the user already has open**, so
those records do not have to be assembled by hand. It uses Outlook's COM automation
interface through a short PowerShell script. There are no credentials, no API, no app
registration, no Graph, no network connection, and nothing is written outside the user's
notes. It is **off unless switched on**, and it never runs on its own.

## What starts it

Exactly two things, both a deliberate press by the person at the keyboard:

| Action | What it does |
|---|---|
| The **Read new mail from Outlook** command | Reads recent items from Inbox and/or Sent Items |
| The **Check this machine** button in settings | Asks Outlook its version number and stops. Opens no folder, reads no message |

There is no scheduler, no timer, no background service and no vault-open hook. Between
presses, nothing runs. Each press starts one `powershell.exe`, which exits in about a second
under a hard timeout.

## What it does, and what it will not do

- **Attaches to a running Outlook; never starts one.** It calls `GetActiveObject`, which
  binds to an existing instance and fails cleanly when there is none. It deliberately does
  not construct the COM object, because that would *launch* the user's mail client.
- **Read-only.** It sends, moves, deletes, saves and marks nothing. Automated tests fail the
  build if any of those methods appear in the script.
- **No network.** Tests likewise fail if `Invoke-WebRequest`, `Invoke-RestMethod`,
  `System.Net` or `curl` appear. A mailbox reader is local or it is nothing.
- **No file is written to disk** by the reader. The script is passed as an argument, not
  dropped somewhere and executed. Message text goes into the user's own notes, inside the
  Obsidian vault, and nowhere else.
- **Attachments stay in the mailbox.** They are named in the note; the bytes are not copied.
- **No registry or system changes.**

## The command line, and why it is base64

```
powershell.exe -NoProfile -NonInteractive -NoLogo -EncodedCommand <base64 of the script>
```

Four values are passed **in the environment**, never inside the script text:
`SCDB_FOLDERS`, `SCDB_SINCE`, `SCDB_MAX`, `SCDB_MAXBODY`. Nothing from a note, a mailbox or a
setting is ever placed into executable source.

**The encoding is a transport requirement, not concealment.** `-EncodedCommand` is the only
mechanism that reliably carries a multi-line script to Windows PowerShell 5.1 from a spawned
process. Feeding the script on standard input (`-Command -`) was measured on Windows
PowerShell 5.1.26100 and does not work at all when standard input is a pipe: the process
exits 0 having executed nothing, silently. Writing the script to a `.ps1` file was rejected
because the plugin is not permitted to write outside the user's vault.

**`-ExecutionPolicy Bypass` is deliberately not used.** Execution policy governs script
*files*; an encoded command is not one, so the switch achieves nothing here — verified on a
machine set to `AllSigned`, where the reader runs unchanged without it. It has been removed
rather than carried, precisely because it is a switch security tooling is right to look at.

## Verifying an alert in about a minute

The script is a **constant in the plugin's source**. It is not assembled at runtime, so it is
the same text on every machine and every run.

1. In Obsidian: **Settings → SCDB Cockpit → Reading Outlook directly → Show what runs**.
2. Press **Copy**. That is the full plaintext of both scripts, the command line and the
   environment variables.
3. Decode the base64 argument from the process-creation event and compare.

They will match character for character. If they do not, something other than this plugin
produced that command line, and that is worth knowing.

## What the user's own records show

Every completed read appends a line to an append-only, hash-chained ledger inside the vault:
the folders read, how far back, how many items were looked at, how many messages were offered
and how long it took — plus Outlook's build number. **No subject, no address, no body.** A
read that finds nothing is still recorded, so "when did this last look at my email" is always
answerable.

## If PowerShell is not permitted on this machine

Then this one feature does not work, and nothing else in the plugin is affected — PowerShell
appears nowhere else in what ships. The user's alternative is to drag a saved `.msg` or
`.eml` message into the vault, which the plugin reads with its own parser and no external
process at all. That route is not a degraded fallback: it runs the same threading,
deduplication and review steps.

If the policy concern is PowerShell specifically rather than mail access, saying so is
useful — the feature can simply be left switched off, which is its default state.

## Honest limitations

- It requires **classic Outlook**. New Outlook and Outlook on the web expose no COM
  automation, so on a machine with only those, this feature cannot work at all.
- As of this version, the read path has **not been exercised against a live mailbox**. It is
  shipped switched off, and the person using it knows this.
