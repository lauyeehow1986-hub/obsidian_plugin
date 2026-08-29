/**
 * The one gateway (CLAUDE.md rule 3). **The only module in this plugin that
 * opens a network connection.**
 *
 * Same shape as `services/protocol`, and for the same reason: that module is
 * the one place a mistake becomes an executed program, and this is the one
 * place a mistake becomes a request leaving the machine. So it is small, it
 * does the checks immediately before the call, and nothing else anywhere may
 * import an HTTP client.
 *
 * **Why Node's `https` rather than Obsidian's `requestUrl`.** `requestUrl`
 * follows redirects itself and reports neither the hops nor the final URL, so
 * an allowlist checked before calling it would only ever have covered the first
 * request. Driving the client directly is the only way to re-check the
 * allowlist **on every hop**, which is what the allowlist is for. It also buys
 * a timeout that actually cancels — `requestUrl` has no abort — and a response
 * size cap. The plugin is `isDesktopOnly`, so Node is present; `backup.ts` and
 * `interpreter.ts` already depend on it.
 *
 * What goes out is a URL this plugin built, never one taken from a note.
 */

import type { IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { toVaultMinute } from "../domain/time/dates";
import {
  checkUrl,
  MIN_INTERVAL_MS,
  SOURCES,
  type SourceId,
  type SourceSpec,
} from "../domain/sources/gateway";
import type { AuditLog } from "./auditLog";

/**
 * Bigger than any of these APIs returns and small enough that a wrong turn
 * cannot exhaust memory. A capped read is abandoned, never truncated and
 * parsed: half a JSON document is not a smaller answer, it is a wrong one.
 */
const MAX_BYTES = 4 * 1024 * 1024;

/** A redirect is legitimate here; a chain of them is not. */
const MAX_REDIRECTS = 3;

export type FetchOutcome =
  | { ok: true; body: string; status: number; url: string }
  | { ok: false; why: string };

export interface GatewayDeps {
  audit: AuditLog;
  actor: () => string;
  /** Read fresh, so switching a source off takes effect without a reload. */
  enabled: (source: SourceId) => boolean;
  timeoutSeconds: () => number;
}

interface NodeHttps {
  request(url: string, options: RequestOptions, callback: (res: IncomingMessage) => void): {
    on(event: "error" | "timeout", handler: (error?: Error) => void): void;
    destroy(error?: Error): void;
    end(): void;
  };
}

/** Reach Node without letting esbuild bundle it, as `services/protocol` does. */
function https(): NodeHttps | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = (globalThis as { require?: (id: string) => unknown }).require?.("https");
    return typeof (mod as NodeHttps | undefined)?.request === "function" ? (mod as NodeHttps) : null;
  } catch {
    return null;
  }
}

export class HttpGateway {
  /** Last request per host, so the politeness interval survives across calls. */
  private readonly lastAt = new Map<string, number>();

  constructor(private readonly deps: GatewayDeps) {}

  /**
   * Fetch one URL, having already shown it to the user and been told yes.
   *
   * This method does not ask. Consent is the caller's job because the caller is
   * the one that can show what the request carries (rule 4); what this method
   * guarantees is that consent cannot reach a host nobody allowlisted.
   *
   * @param carries one line for the ledger saying what the request was for.
   */
  async fetch(url: string, carries: string): Promise<FetchOutcome> {
    const gate = checkUrl(url);
    if (!gate.ok) return { ok: false, why: gate.why };

    const spec = SOURCES[gate.source];
    if (!this.deps.enabled(gate.source)) {
      return {
        ok: false,
        why: `${spec.label} is switched off in settings, so nothing was sent.`,
      };
    }

    await this.beCivil(gate.source);

    const result = await this.hop(url, 0);

    // Logged once a request is actually attempted, whether it then succeeds
    // or fails: a ledger holding only the successful ones would be a
    // flattering record rather than a true one (rule 9).
    //
    // The two refusals above are deliberately *not* logged, and the line is
    // worth being precise about: neither opened a socket, so nothing left the
    // machine and the ledger — which answers "what has this vault sent" —
    // has nothing to record. Both are reported to the caller instead, where
    // the person who asked can see them.
    await this.log(gate.source, url, carries, result);
    return result;
  }

  /** Clamped here as well as in settings: `data.json` can be hand-edited. */
  private timeoutMs(): number {
    return Math.max(5, Math.min(120, Math.round(this.deps.timeoutSeconds()))) * 1000;
  }

  /**
   * Wait out NCBI's rate limit rather than being blocked by it.
   *
   * Blocking would present on the target machine as "the feature is broken",
   * with no developer tools to find out otherwise.
   */
  private async beCivil(source: SourceId): Promise<void> {
    const host = SOURCES[source].host;
    const since = Date.now() - (this.lastAt.get(host) ?? 0);
    const wait = MIN_INTERVAL_MS[source] - since;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastAt.set(host, Date.now());
  }

  /**
   * One request, re-checking the allowlist for each redirect.
   *
   * A redirect is a server telling us to go somewhere else. Following it
   * without re-checking would let an allowlisted host hand us to one that is
   * not, which is precisely the hole the allowlist exists to close.
   */
  private async hop(url: string, depth: number): Promise<FetchOutcome> {
    const gate = checkUrl(url);
    if (!gate.ok) {
      return {
        ok: false,
        why:
          depth === 0
            ? gate.why
            : `The service redirected somewhere that is not on the allowlist, so nothing was read. ${gate.why}`,
      };
    }
    if (depth > MAX_REDIRECTS) {
      return { ok: false, why: "The service kept redirecting, so the request was abandoned." };
    }

    const response = await send(url, this.timeoutMs(), SOURCES[gate.source]);

    if (response.kind === "fail") return { ok: false, why: response.why };

    if (response.status >= 300 && response.status < 400 && response.location !== "") {
      // Resolved against the current URL, then checked from scratch.
      let next: string;
      try {
        next = new URL(response.location, url).toString();
      } catch {
        return { ok: false, why: "The service redirected to something that is not a URL." };
      }
      return this.hop(next, depth + 1);
    }

    if (response.status < 200 || response.status >= 300) {
      // The body of an error is usually the actual answer — ClinicalTrials.gov
      // replies to a bad parameter with a sentence saying which one.
      const said = response.body.trim().slice(0, 300);
      return {
        ok: false,
        why:
          said === ""
            ? `${SOURCES[gate.source].label} answered ${response.status}.`
            : `${SOURCES[gate.source].label} answered ${response.status}: ${said}`,
      };
    }

    return { ok: true, body: response.body, status: response.status, url };
  }

  private async log(
    source: SourceId,
    url: string,
    carries: string,
    result: FetchOutcome,
  ): Promise<void> {
    const actor = this.deps.actor();
    const outcome = result.ok ? `${result.body.length} bytes` : `failed: ${result.why}`;
    try {
      await this.deps.audit.append([
        {
          ts: toVaultMinute(Date.now()),
          actor: actor === "" ? "unknown" : actor,
          action: "source-fetch",
          subject: SOURCES[source].host,
          // The query is included deliberately. The point of this row is that a
          // reader six months later can see what left the machine, and "a
          // search happened" does not answer that. It is the user's own typed
          // search term, and they were shown the URL before it went.
          detail: `${carries} — ${outcome}. ${trimUrl(url)}`,
        },
      ]);
    } catch {
      // A ledger that cannot be written must not silently swallow the fact.
      console.error("SCDB: could not record a source fetch in the audit ledger.");
    }
  }
}

type Reply =
  | { kind: "done"; status: number; body: string; location: string }
  | { kind: "fail"; why: string };

/**
 * One HTTPS GET, with a timeout that cancels and a cap on what it will read.
 *
 * Separated from `hop` so that method stays about the decisions — allowlist,
 * redirect, status — rather than about plumbing. Nothing here decides whether
 * a request is allowed; by the time it is called, that is settled.
 */
async function send(url: string, timeout: number, spec: SourceSpec): Promise<Reply> {
  const client = https();
  if (client === null) {
    return { kind: "fail", why: "Node's https module is not available in this build of Obsidian." };
  }

  return new Promise<Reply>((resolve) => {
    let settled = false;
    const finish = (value: Reply): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const request = client.request(
      url,
      {
        method: "GET",
        timeout,
        headers: {
          // Identifies the tool, and nothing else. No version, no machine, no
          // user — a User-Agent is HTTP hygiene, not an update ping.
          "User-Agent": "scdb-cockpit",
          Accept: "application/json, text/plain",
          // Avoids a decompression path for replies measured in kilobytes.
          "Accept-Encoding": "identity",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            res.destroy();
            finish({ kind: "fail", why: "The reply was larger than the plugin will read." });
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const location = res.headers["location"];
          finish({
            kind: "done",
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            location: typeof location === "string" ? location : "",
          });
        });
        res.on("error", () => finish({ kind: "fail", why: "The reply was cut short." }));
      },
    );

    request.on("timeout", () => {
      request.destroy();
      finish({ kind: "fail", why: `${spec.label} did not answer within ${timeout / 1000} seconds.` });
    });
    request.on("error", (error) => {
      // The offline case, and the one rule 10 cares about most: it has to read
      // as "unavailable", never as a stack trace.
      finish({ kind: "fail", why: `Could not reach ${spec.host}. ${describe(error)}` });
    });
    request.end();
  });
}

/** Ledger cells are read in a table; a 400-character URL makes it unreadable. */
function trimUrl(url: string): string {
  return url.length > 160 ? `${url.slice(0, 157)}...` : url;
}

function describe(error: Error | undefined): string {
  const code = (error as { code?: string } | undefined)?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "The name did not resolve, which usually means no network.";
  }
  if (code === "ECONNREFUSED") return "The connection was refused.";
  if (code === "ETIMEDOUT") return "The connection timed out.";
  if (code === "CERT_HAS_EXPIRED" || code.startsWith("UNABLE_TO_VERIFY")) {
    return "The certificate could not be verified, so nothing was read.";
  }
  return code === "" ? "The connection failed." : `The connection failed (${code}).`;
}
