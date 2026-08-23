/**
 * The English search box (CLAUDE.md §7 B4).
 *
 * What makes this auditable rather than magic is directly below the box: every
 * phrase that was understood is a chip saying what it will do, and every word
 * that was not is listed. Nothing is hidden and nothing is inferred.
 *
 * Each chip knows the characters it came from, so its ✕ deletes exactly those
 * words from the box. The text and the chips therefore cannot disagree — there
 * is no second copy of the query to fall out of step with what is typed.
 *
 * Chips are labelled by role in words, not by colour alone (§6).
 */

import { textWithoutChip, type Chip, type ParsedText } from "../domain/query/language";

const ROLE: Record<Chip["kind"], string> = {
  type: "type",
  filter: "where",
  sort: "sort",
  group: "group",
  aggregate: "total",
  limit: "limit",
};

const EXAMPLES = [
  "stuck in approval more than 2 weeks",
  "overdue, not delivered",
  "in extraction, identifiable",
  "median dwell by stage",
  "top 10 longest waiting",
];

export function LanguageSearch({
  text,
  parsed,
  onChange,
}: {
  text: string;
  parsed: ParsedText;
  onChange: (text: string) => void;
}) {
  return (
    <div class="scdb-search">
      <div class="scdb-search__row">
        <input
          type="search"
          class="scdb-search__input"
          value={text}
          aria-label="Search in English"
          placeholder="Ask in English — requests stuck in approval more than 2 weeks"
          onInput={(event) => onChange((event.currentTarget as HTMLInputElement).value)}
        />
        {text !== "" && (
          <button type="button" class="scdb-link" onClick={() => onChange("")}>
            clear
          </button>
        )}
      </div>

      {parsed.chips.length > 0 && (
        <div class="scdb-chips scdb-search__chips">
          {parsed.chips.map((chip) => (
            <span key={chip.id} class={`scdb-searchchip scdb-searchchip--${chip.kind}`}>
              <span class="scdb-searchchip__role">{ROLE[chip.kind]}</span>
              <span class="scdb-searchchip__label">{chip.label}</span>
              <button
                type="button"
                class="scdb-searchchip__drop"
                aria-label={`Remove “${chip.source}”`}
                title={`Remove “${chip.source}”`}
                onClick={() => onChange(textWithoutChip(text, chip))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {parsed.ignored.length > 0 && (
        <p class="scdb-search__ignored">
          <strong>Not understood:</strong> {parsed.ignored.join(" · ")}. Nothing was guessed —
          those words had no effect on the filters below.
        </p>
      )}

      {text.trim() === "" && (
        <p class="scdb-muted scdb-search__hint">
          Offline and deterministic: it only knows this vault's stages, fields and names. Try{" "}
          {EXAMPLES.map((example, index) => (
            <span key={example}>
              {index > 0 && " · "}
              <button type="button" class="scdb-link" onClick={() => onChange(example)}>
                {example}
              </button>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
