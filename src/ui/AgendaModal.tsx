import type { App } from "obsidian";
import { useMemo, useState } from "preact/hooks";
import {
  buildAgenda,
  summariseAgenda,
  type Agenda,
  type AgendaInput,
  type AgendaItem,
} from "../domain/comms/agenda";
import {
  composeMessage,
  draftSummary,
  type ComposedDraft,
  type MessageTemplate,
} from "../domain/comms/message";
import { buildMailto, deliveryFor, type ComposeResult } from "../domain/comms/uri";
import { duration } from "./format";
import { PreactModal } from "./PreactModal";

/**
 * The meeting agenda and the chase-up composer (CLAUDE.md §7 B1).
 *
 * One dialog rather than two, because they are one action with two endings:
 * you look at what a person is holding up, and then you either walk down the
 * list in a meeting or you send it to them. Splitting them would mean picking
 * the person twice.
 *
 * **The draft is always shown before anything is opened.** Not because a
 * mailto is dangerous — nothing is sent — but because §5.11 rule 5 keeps
 * identifiers out of URIs by construction, and the only way a person can
 * satisfy themselves that it worked is to read what is about to go through the
 * OS shell.
 */

export type Channel = "email" | "teams" | "clipboard";

export interface AgendaSend {
  channel: Channel;
  draft: ComposedDraft;
  agenda: Agenda;
  /** Recipient addresses, as typed. Validated in `domain/comms/uri`, not here. */
  addresses: string[];
  /** One line for the thread's message log. Never the body. */
  summary: string;
}

interface PanelProps {
  agenda: Agenda;
  draft: ComposedDraft;
  ceiling: number;
  knownAddress: string;
  /** UPN for the Teams deep link, when the person note declares one. */
  knownTeamsAddress: string;
  onSend: (send: AgendaSend) => void;
  onCopyAgenda: (markdown: string) => void;
  onClose: () => void;
}

/** The agenda as markdown, for the clipboard and for pasting into minutes. */
export function agendaMarkdown(agenda: Agenda): string {
  if (agenda.items.length === 0) {
    return `## ${agenda.party.name}\n\nNothing open with this person.\n`;
  }
  return [
    `## ${agenda.party.name}`,
    "",
    `${summariseAgenda(agenda)}.`,
    "",
    ...agenda.items.map(
      (item) =>
        `- **[[${item.link}]]**${item.title === "" ? "" : ` — ${item.title}`}  \n` +
        `  ${item.ask} ${item.context}`,
    ),
    "",
  ].join("\n");
}

function ItemRow({ item }: { item: AgendaItem }) {
  return (
    <li class={`scdb-agenda__item${item.urgent ? " scdb-agenda__item--urgent" : ""}`}>
      <div class="scdb-agenda__head">
        <span class="scdb-agenda__kind">{item.kind}</span>
        <span class="scdb-agenda__link">{item.link}</span>
        {item.title === "" ? null : <span class="scdb-agenda__title">{item.title}</span>}
        {/* Colour is never the only signal (§6): glyph and word too, and the
            same vocabulary the boards and the HTML export use. */}
        {item.urgent ? (
          <span class="scdb-state scdb-state--overdue">
            <span aria-hidden="true">!</span>
            Overdue
          </span>
        ) : null}
        <span class="scdb-agenda__age">{duration(item.waitedMs)}</span>
      </div>
      <div class="scdb-agenda__detail">
        {item.ask} {item.context}
      </div>
    </li>
  );
}

function AgendaPanel({
  agenda,
  draft,
  ceiling,
  knownAddress,
  knownTeamsAddress,
  onSend,
  onCopyAgenda,
  onClose,
}: PanelProps) {
  const [addresses, setAddresses] = useState(knownAddress);
  // Teams resolves a UPN, not an SMTP alias, so the two channels can need
  // different strings for the same person. While the box is untouched the
  // Teams button uses the UPN the note declares; the moment it is edited,
  // what is typed wins for both — an override the user can see beats one
  // they cannot.
  const [edited, setEdited] = useState(false);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [summary, setSummary] = useState(draftSummary(agenda));

  const list = useMemo(
    () =>
      addresses
        .split(/[\s;]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ""),
    [addresses],
  );

  // Built on every keystroke so the length readout is honest about the draft
  // as it stands, not as it was when the dialog opened.
  const built: ComposeResult = useMemo(
    () => buildMailto({ to: list, subject, body }),
    [list, subject, body],
  );
  const willCopy = built.ok && deliveryFor(built.uri, ceiling) === "clipboard";

  const send = (channel: Channel) =>
    onSend({
      channel,
      draft: { subject, body, unknown: draft.unknown },
      agenda,
      addresses:
        channel === "teams" && !edited && knownTeamsAddress !== ""
          ? [knownTeamsAddress]
          : list,
      summary: summary.trim() === "" ? draftSummary(agenda) : summary.trim(),
    });

  return (
    <div class="scdb-modal__body scdb-agenda">
      <p class="scdb-modal__lede">
        {agenda.items.length === 0
          ? "Nothing open with this person."
          : `${summariseAgenda(agenda)} · longest wait ${duration(agenda.longestWaitMs)}`}
      </p>

      {agenda.items.length === 0 ? (
        <p class="scdb-empty">
          Nothing is recorded as waiting on them. Set <code>blocked_on</code> when you move a
          request, and this becomes the list you walk down in the meeting.
        </p>
      ) : (
        <ul class="scdb-agenda__list">
          {agenda.items.map((item) => (
            <ItemRow key={`${item.kind}:${item.link}`} item={item} />
          ))}
        </ul>
      )}

      <div class="scdb-modal__actions">
        <button type="button" class="scdb-control" onClick={() => onCopyAgenda(agendaMarkdown(agenda))}>
          Copy agenda
        </button>
      </div>

      <hr class="scdb-rule" />

      <h4 class="scdb-subhead">Chase-up draft</h4>
      <p class="scdb-note">
        Nothing is sent. The draft opens in your mail client or Teams and you press send.
      </p>

      {draft.unknown.length > 0 ? (
        <p class="scdb-warning">
          The template uses {draft.unknown.map((name) => `{{${name}}}`).join(", ")}, which the
          composer does not provide. Those are left in the text as written so they can be fixed.
        </p>
      ) : null}

      <label class="scdb-field">
        <span class="scdb-field__label">To</span>
        <input
          type="text"
          placeholder="a.tan@hospital.edu.sg"
          value={addresses}
          onInput={(event) => {
            setEdited(true);
            setAddresses((event.target as HTMLInputElement).value);
          }}
        />
        {!edited && knownTeamsAddress !== "" && knownTeamsAddress !== knownAddress ? (
          <span class="scdb-field__hint">
            Teams will use {knownTeamsAddress} — the UPN this person’s note declares. Editing
            this box uses what you type for both.
          </span>
        ) : null}
      </label>

      <label class="scdb-field">
        <span class="scdb-field__label">Subject</span>
        <input
          type="text"
          value={subject}
          onInput={(event) => setSubject((event.target as HTMLInputElement).value)}
        />
      </label>

      <label class="scdb-field">
        <span class="scdb-field__label">Message</span>
        <textarea
          rows={8}
          value={body}
          onInput={(event) => setBody((event.target as HTMLTextAreaElement).value)}
        />
      </label>

      <label class="scdb-field">
        <span class="scdb-field__label">Recorded on the thread as</span>
        <input
          type="text"
          value={summary}
          onInput={(event) => setSummary((event.target as HTMLInputElement).value)}
        />
        <span class="scdb-field__hint">
          One line. The message text is not stored on the thread note.
        </span>
      </label>

      {!built.ok ? (
        <p class="scdb-warning">{built.problems.join(" ")}</p>
      ) : (
        <p class="scdb-note">
          {built.uri.length} characters; the limit is {ceiling}.{" "}
          {willCopy
            ? "Too long to open safely, so this will go to the clipboard instead of being cut off."
            : "Short enough to open directly."}
        </p>
      )}

      <div class="scdb-modal__actions">
        <button type="button" class="scdb-control" onClick={onClose}>
          Close
        </button>
        <button type="button" class="scdb-control" onClick={() => send("clipboard")}>
          Copy message
        </button>
        <button type="button" class="scdb-control" onClick={() => send("teams")}>
          Teams
        </button>
        <button
          type="button"
          class="mod-cta"
          disabled={!built.ok}
          onClick={() => send("email")}
        >
          {willCopy ? "Copy for email" : "Open in email"}
        </button>
      </div>
    </div>
  );
}

export interface AgendaModalOptions {
  input: AgendaInput;
  template: MessageTemplate;
  actor: string;
  ceiling: number;
  /** An address already recorded for this person, if the vault holds one. */
  knownAddress?: string;
  knownTeamsAddress?: string;
  onSend: (send: AgendaSend) => Promise<void>;
  onCopyAgenda: (markdown: string) => Promise<void>;
}

export class AgendaModal extends PreactModal {
  private readonly agenda: Agenda;
  private readonly draft: ComposedDraft;

  constructor(
    app: App,
    private readonly options: AgendaModalOptions,
  ) {
    super(app);
    this.agenda = buildAgenda(options.input);
    this.draft = composeMessage(options.template, {
      agenda: this.agenda,
      now: options.input.now,
      actor: options.actor,
    });
    this.titleEl.setText(`Agenda · ${this.agenda.party.name}`);
  }

  protected body() {
    return (
      <AgendaPanel
        agenda={this.agenda}
        draft={this.draft}
        ceiling={this.options.ceiling}
        knownAddress={this.options.knownAddress ?? ""}
        knownTeamsAddress={this.options.knownTeamsAddress ?? ""}
        onClose={() => this.close()}
        onCopyAgenda={(markdown) => {
          void this.options.onCopyAgenda(markdown);
        }}
        onSend={(send) => {
          this.close();
          void this.options.onSend(send);
        }}
      />
    );
  }
}
