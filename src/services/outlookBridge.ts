/**
 * The local Outlook reader (CLAUDE.md §5.10 Tier 2, §7 E2).
 *
 * A PowerShell process attaches to the Outlook that is **already running**,
 * reads mail items through COM, and prints them back as JSON. No credentials,
 * no API, no app registration, no Graph, nothing over a network. The parsing is
 * all in `domain/comms/outlook`; this module's whole job is to run the thing
 * without letting it hurt anything.
 *
 * ## Why this is out of process, and why the timeout is the feature
 *
 * §7 E2 states the hazard plainly: **Outlook COM can block for minutes on a
 * modal dialog**, and Obsidian must never freeze. A security prompt, a password
 * box, a "do you want to allow access to email addresses" dialog, an add-in
 * mid-upgrade — any of them stops the call dead. In-process that is a hung
 * editor with no way out but Task Manager. Out of process it is a child that
 * misses its deadline and gets killed, and the user is told which.
 *
 * So the timeout is not defensive garnish. It is the reason the design is
 * shaped this way, and it is why `kill` escalates rather than asking politely.
 *
 * ## Three decisions worth stating
 *
 *  - **It attaches; it never launches.** `GetActiveObject` binds to a running
 *    instance and fails with `MK_E_UNAVAILABLE` when there is none.
 *    `New-Object -ComObject Outlook.Application` would *start* Outlook, and a
 *    sync that opens your mail client — downloading mail, firing notifications,
 *    possibly prompting for a password — is exactly the surprise rule 12 exists
 *    to prevent. Not running is a sentence, not a fault.
 *  - **The script is a constant, and its parameters are environment
 *    variables.** Nothing from a note, a mailbox or a setting is ever
 *    interpolated into PowerShell source. `-EncodedCommand` carries the script
 *    as one base64 argument, so there is no temp file to write (rule 8 keeps us
 *    out of `fs`) and no quoting for anything to escape from.
 *  - **The reply comes back base64-encoded.** PowerShell 5.1 writes stdout in
 *    the console codepage, and the whole point of a mailbox reader is text full
 *    of smart quotes, £ signs and accented names — the exact bytes the `.eml`
 *    reader already had to learn about the hard way. Base64 is ASCII, so no
 *    codepage can touch it, and the JSON inside is decoded as UTF-8 here.
 *
 * `powershell.exe` deliberately, not `pwsh`: `Marshal.GetActiveObject` is a
 * .NET Framework API and is absent from .NET Core, so Windows PowerShell 5.1 —
 * which every Windows machine has and no locked-down laptop needs permission to
 * install — is the only host this works under.
 */

import { spawn } from "node:child_process";
import { parseBridgeReport, type BridgeOutcome, type OutlookFolder } from "../domain/comms/outlook";

/** Anything longer than this from the child is a runaway, not a mailbox. */
const MAX_OUTPUT_BYTES = 24 * 1024 * 1024;

/** Bodies longer than this are cut, and the note says they were. */
export const MAX_BODY_CHARS = 100_000;

export interface OutlookReadRequest {
  folders: readonly OutlookFolder[];
  /** Only items at or after this local wall-clock time are read. */
  since: Date;
  /** Hard cap on items returned, across all folders. */
  max: number;
  timeoutMs: number;
}

export interface BridgeRun {
  outcome: BridgeOutcome;
  /** Wall-clock milliseconds the child took, for the diagnostics report. */
  elapsedMs: number;
  /** True when the deadline was hit and the child was killed. */
  timedOut: boolean;
}

/**
 * The reader, as it is sent to PowerShell.
 *
 * Read it as the contract it is: this is the only code in the plugin that
 * touches a mailbox, and everything it may do is visible here.
 *
 * Notes on the choices that are not obvious:
 *
 *  - **Sort and walk, rather than `Restrict`.** A DASL restriction on a date is
 *    the usual idiom and it is a locale minefield — the filter string's date
 *    format depends on the property and on how Outlook was built. Sorting
 *    descending and stopping at the first item older than the window needs no
 *    filter language at all, and the cap bounds it either way.
 *  - **`GetFirst`/`GetNext`, not `foreach`.** Enumerating an Outlook `Items`
 *    collection with the pipeline does not reliably honour `Sort`; the explicit
 *    cursor does.
 *  - **Every property read is wrapped.** MAPI raises rather than returning
 *    empty for a property an item does not carry, and most items do not carry
 *    most of these. One missing header must not lose the whole sync.
 *  - **Only `IPM.Note`.** A meeting request, a delivery report and a calendar
 *    item are not correspondence, and reading their properties as if they were
 *    would file nonsense into a thread.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Emit($obj) {
  $json = $obj | ConvertTo-Json -Depth 6 -Compress
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
}

function Prop($accessor, $tag) {
  try {
    $v = $accessor.GetProperty($tag)
    if ($null -eq $v) { return '' }
    return [string]$v
  } catch { return '' }
}

function PropHex($accessor, $tag) {
  try {
    $v = $accessor.GetProperty($tag)
    if ($null -eq $v) { return '' }
    return ([BitConverter]::ToString([byte[]]$v)).Replace('-','').ToLowerInvariant()
  } catch { return '' }
}

function Stamp($value) {
  try {
    if ($null -eq $value) { return '' }
    $d = [datetime]$value
    if ($d.Year -lt 1990) { return '' }
    return $d.ToString('yyyy-MM-ddTHH:mm:sszzz', [Globalization.CultureInfo]::InvariantCulture)
  } catch { return '' }
}

try {
  $maxItems = [int]$env:SCDB_MAX
  $maxBody  = [int]$env:SCDB_MAXBODY
  $since    = [datetime]::ParseExact($env:SCDB_SINCE, 'yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture)
  $wanted   = $env:SCDB_FOLDERS -split ','
} catch {
  Emit @{ error = 'The Outlook reader was given settings it could not read.' }
  exit 0
}

try {
  $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application')
} catch {
  Emit @{ error = 'OUTLOOK_NOT_RUNNING' }
  exit 0
}

$problems = New-Object System.Collections.ArrayList
$items    = New-Object System.Collections.ArrayList
$scanned  = 0
$skipped  = 0

try {
  $ns = $outlook.GetNamespace('MAPI')
} catch {
  Emit @{ error = 'Outlook is running but would not hand over its MAPI session.' }
  exit 0
}

foreach ($name in $wanted) {
  if ($items.Count -ge $maxItems) { break }

  $id = 0
  if ($name -eq 'inbox') { $id = 6 } elseif ($name -eq 'sent') { $id = 5 } else { continue }
  $label = $(if ($id -eq 6) { 'Inbox' } else { 'Sent Items' })

  try {
    $folder = $ns.GetDefaultFolder($id)
    $collection = $folder.Items
    $collection.Sort('[ReceivedTime]', $true)
  } catch {
    [void]$problems.Add("The $label folder could not be opened: $($_.Exception.Message)")
    continue
  }

  $item = $null
  try { $item = $collection.GetFirst() } catch { $item = $null }

  while ($null -ne $item) {
    if ($items.Count -ge $maxItems) { break }
    $scanned = $scanned + 1

    $received = $null
    try { $received = [datetime]$item.ReceivedTime } catch { $received = $null }
    # Sorted newest first, so the first item older than the window ends this
    # folder. An item with no readable date is passed over, never used to stop.
    if ($null -ne $received -and $received -lt $since) { break }

    $class = ''
    try { $class = [string]$item.MessageClass } catch { $class = '' }

    if ($class -notlike 'IPM.Note*') {
      $skipped = $skipped + 1
    } else {
      $itemProblems = New-Object System.Collections.ArrayList
      $accessor = $null
      try { $accessor = $item.PropertyAccessor } catch { $accessor = $null }

      $body = ''
      try { $body = [string]$item.Body } catch { $body = '' }
      $html = ''
      if ($body.Trim() -eq '') {
        try { $html = [string]$item.HTMLBody } catch { $html = '' }
      }
      if ($body.Length -gt $maxBody) {
        $body = $body.Substring(0, $maxBody)
        [void]$itemProblems.Add('This message is very long and only its first part was read. The whole of it is still in Outlook.')
      }
      if ($html.Length -gt $maxBody) {
        $html = $html.Substring(0, $maxBody)
        [void]$itemProblems.Add('This message is very long and only its first part was read. The whole of it is still in Outlook.')
      }

      $recipients = New-Object System.Collections.ArrayList
      try {
        foreach ($r in $item.Recipients) {
          $address = ''
          try { $address = Prop $r.PropertyAccessor 'http://schemas.microsoft.com/mapi/proptag/0x39FE001F' } catch { $address = '' }
          if ($address -notlike '*@*') {
            try { $address = [string]$r.Address } catch { $address = '' }
          }
          $rname = ''
          try { $rname = [string]$r.Name } catch { $rname = '' }
          $kind = 1
          try { $kind = [int]$r.Type } catch { $kind = 1 }
          [void]$recipients.Add(@{ name = $rname; address = $address; kind = $kind })
        }
      } catch {
        [void]$itemProblems.Add('The recipient list on this message could not be read.')
      }

      $attachments = New-Object System.Collections.ArrayList
      try {
        foreach ($a in $item.Attachments) {
          try { [void]$attachments.Add([string]$a.FileName) } catch { }
        }
      } catch { }

      $entry = ''
      try { $entry = [string]$item.EntryID } catch { $entry = '' }
      $subject = ''
      try { $subject = [string]$item.Subject } catch { $subject = '' }
      $senderName = ''
      try { $senderName = [string]$item.SenderName } catch { $senderName = '' }
      $senderAddress = ''
      try { $senderAddress = [string]$item.SenderEmailAddress } catch { $senderAddress = '' }
      $senderType = ''
      try { $senderType = [string]$item.SenderEmailType } catch { $senderType = '' }
      $sentOn = ''
      try { $sentOn = Stamp $item.SentOn } catch { $sentOn = '' }

      [void]$items.Add(@{
        entryId           = $entry
        folder            = $label
        messageClass      = $class
        headers           = $(if ($null -ne $accessor) { Prop $accessor 'http://schemas.microsoft.com/mapi/proptag/0x007D001F' } else { '' })
        subject           = $subject
        body              = $body
        htmlBody          = $html
        sentOn            = $sentOn
        receivedTime      = Stamp $received
        senderName        = $senderName
        senderAddress     = $senderAddress
        senderAddressType = $senderType
        senderSmtp        = $(if ($null -ne $accessor) { Prop $accessor 'http://schemas.microsoft.com/mapi/proptag/0x5D01001F' } else { '' })
        internetMessageId = $(if ($null -ne $accessor) { Prop $accessor 'http://schemas.microsoft.com/mapi/proptag/0x1035001F' } else { '' })
        inReplyTo         = $(if ($null -ne $accessor) { Prop $accessor 'http://schemas.microsoft.com/mapi/proptag/0x1042001F' } else { '' })
        references        = $(if ($null -ne $accessor) { Prop $accessor 'http://schemas.microsoft.com/mapi/proptag/0x1039001F' } else { '' })
        conversationIndex = $(if ($null -ne $accessor) { PropHex $accessor 'http://schemas.microsoft.com/mapi/proptag/0x00710102' } else { '' })
        recipients        = @($recipients)
        attachments       = @($attachments)
        problems          = @($itemProblems)
      })
    }

    try { $item = $collection.GetNext() } catch { $item = $null }
  }
}

$version = ''
try { $version = [string]$outlook.Version } catch { $version = '' }

Emit @{
  items          = @($items)
  scanned        = $scanned
  skipped        = $skipped
  outlookVersion = $version
  problems       = @($problems)
}
`;

/** PowerShell wants the script as UTF-16LE base64 for `-EncodedCommand`. */
export function encodeCommand(script: string): string {
  const bytes = new Uint8Array(script.length * 2);
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = code >> 8;
  }
  return Buffer.from(bytes).toString("base64");
}

/** `yyyy-MM-dd HH:mm`, the one format the script parses, invariant culture. */
export function sinceArgument(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * "Outlook is not running" said properly.
 *
 * The script reports a token rather than prose so the sentence lives here with
 * the rest of the user-facing text, and so a future caller can tell this apart
 * from a real failure — it is the ordinary case, not an error.
 */
export const NOT_RUNNING =
  "Outlook is not running, so there was nothing to read. Open Outlook, wait for it to finish " +
  "starting, and try again. This reads the session you are already signed in to — it will " +
  "never start Outlook for you.";

/**
 * Is this machine able to do it at all — without reading a single message.
 *
 * §11 asks the mailto and Teams questions this same way, and for the same
 * reason: the dev laptop cannot answer for the work laptop, so the answer has
 * to be obtainable there in ten seconds. This attaches, asks Outlook its
 * version, and lets go. It opens no folder and touches no item, so it is safe
 * to press on a machine whose mail you have not decided to let the plugin see.
 */
const PROBE = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application')
} catch {
  [Console]::Out.Write('NOTRUNNING')
  exit 0
}
try {
  [Console]::Out.Write('OK ' + [string]$outlook.Version)
} catch {
  [Console]::Out.Write('OK')
}
`;

export interface OutlookProbe {
  running: boolean;
  /** Outlook's version when it answered, else "". */
  version: string;
  detail: string;
}

export function probeOutlook(timeoutMs = 20_000): Promise<OutlookProbe> {
  return new Promise((resolve) => {
    let settled = false;
    let out = "";

    const done = (probe: OutlookProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(probe);
    };

    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodeCommand(PROBE)],
      { shell: false, windowsHide: true },
    );

    const deadline = setTimeout(
      () => {
        child.kill();
        setTimeout(() => child.kill("SIGKILL"), 2000);
        done({
          running: false,
          version: "",
          detail:
            "Outlook did not answer in time. It is probably showing a dialog — bring it to the " +
            "front, clear whatever it is asking, and try again.",
        });
      },
      Math.max(2000, timeoutMs),
    );

    child.stdout.setEncoding("ascii");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", (error: Error) =>
      done({
        running: false,
        version: "",
        detail: `Windows PowerShell could not be started (${error.message}).`,
      }),
    );
    child.on("close", () => {
      const text = out.trim();
      if (text.startsWith("OK")) {
        const version = text.slice(2).trim();
        done({
          running: true,
          version,
          detail:
            version === ""
              ? "Outlook answered. Reading mail from it will work on this machine."
              : `Outlook ${version} answered. Reading mail from it will work on this machine.`,
        });
        return;
      }
      if (text === "NOTRUNNING") {
        done({
          running: false,
          version: "",
          detail:
            "Outlook is not running, so there was nothing to ask. Open classic Outlook and try " +
            "again. If this machine has only the new Outlook or the web app, reading directly " +
            "is not possible here — drag messages into the vault instead.",
        });
        return;
      }
      done({
        running: false,
        version: "",
        detail: "Windows PowerShell answered with something unexpected, so this could not be checked.",
      });
    });
  });
}

export function readOutlook(request: OutlookReadRequest): Promise<BridgeRun> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let bytes = 0;

    const finish = (outcome: BridgeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ outcome, elapsedMs: Date.now() - started, timedOut });
    };

    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodeCommand(SCRIPT),
      ],
      {
        // Array arguments and no shell: there is no command string for
        // anything to be appended to, which is the same rule F1 applies to
        // interpreters.
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          SCDB_FOLDERS: request.folders.join(","),
          SCDB_SINCE: sinceArgument(request.since),
          SCDB_MAX: String(Math.max(1, Math.floor(request.max))),
          SCDB_MAXBODY: String(MAX_BODY_CHARS),
        },
      },
    );

    // The point of the whole design. A COM call blocked behind a modal dialog
    // never returns, so the deadline is what guarantees Obsidian carries on.
    const deadline = setTimeout(
      () => {
        timedOut = true;
        child.kill();
        setTimeout(() => child.kill("SIGKILL"), 2000);
        finish({
          why:
            `Outlook did not answer within ${Math.round(request.timeoutMs / 1000)} seconds, so the reader was stopped. ` +
            "This usually means Outlook is showing a dialog and is waiting for you — bring it to " +
            "the front, clear whatever it is asking, and run this again. Nothing was written.",
        });
      },
      Math.max(2000, request.timeoutMs),
    );

    child.stdout.setEncoding("ascii");
    child.stdout.on("data", (chunk: string) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish({ why: "The Outlook reader returned far more than expected and was stopped." });
        return;
      }
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk;
    });

    child.on("error", (error: Error) => {
      finish({
        why:
          `Windows PowerShell could not be started (${error.message}). ` +
          "The Outlook reader needs powershell.exe, which is part of Windows.",
      });
    });

    child.on("close", (code) => {
      if (settled) return;

      const text = decode(stdout.trim());
      if (text === null) {
        finish({
          why:
            code === 0
              ? "The Outlook reader finished but said nothing this plugin could read."
              : `The Outlook reader stopped with code ${String(code)}.${stderr.trim() === "" ? "" : ` It said: ${firstLine(stderr)}`}`,
        });
        return;
      }

      const report = parseBridgeReport(text);
      if ("why" in report && report.why === "OUTLOOK_NOT_RUNNING") {
        finish({ why: NOT_RUNNING });
        return;
      }
      finish(report);
    });
  });
}

/** Base64 in, JSON text out. Null when it was not base64 at all. */
function decode(text: string): string | null {
  if (text === "") return null;
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(text)) return null;
  try {
    return Buffer.from(text, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}
