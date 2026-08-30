// Control UI view for the HSMA hate-speech monitoring tab.
//
// Four things an operator needs to answer at a glance: what is waiting for a human,
// what the agent is watching, what it is matching with and how stale that is, and
// whether findings are actually reaching the platform.
import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import "../../styles/hsma.css";
import {
  configureHsmaPolling,
  getHsmaState,
  loadHsma,
  type HsmaCase,
  type HsmaReviewItem,
} from "./hsma-controller.ts";

const HOURS = Array.from({ length: 24 }, (_, i) => i);

function sectionError(state: ReturnType<typeof getHsmaState>, method: string) {
  const message = state.errors[method];
  return message ? html`<p class="hsma-error">${message}</p>` : nothing;
}

/** 24 cells, filled where the agent has learned to crawl. Gaps are the point. */
function renderHours(c: HsmaCase): TemplateResult {
  const active = new Set(c.hours ?? []);
  return html`
    <div class="hsma-hours" title=${c.why ?? ""}>
      ${HOURS.map(
        (h) =>
          html`<span
            class=${active.has(h) ? "hsma-hour hsma-hour--on" : "hsma-hour"}
            title=${`${String(h).padStart(2, "0")}:00 UTC`}
          ></span>`,
      )}
    </div>
    <p class="hsma-muted">
      ${c.learned
        ? `Learned from when flagged content was posted. ${c.why ?? ""}`
        : "Not enough observations yet — crawling a baseline spread instead."}
    </p>
  `;
}

function renderReviewItem(item: HsmaReviewItem): TemplateResult {
  return html`
    <li class="hsma-review-item">
      <div class="hsma-review-head">
        <span class=${`hsma-verdict hsma-verdict--${item.verdict}`}>${item.verdict}</span>
        ${item.confidence != null
          ? html`<span class="hsma-muted">confidence ${item.confidence.toFixed(2)}</span>`
          : nothing}
        ${item.lexiconAgeHours != null
          ? html`<span class="hsma-muted" title="How stale the dictionary was when this was judged"
              >lexicon ${Math.round(item.lexiconAgeHours)}h old</span
            >`
          : nothing}
      </div>
      <p class="hsma-review-text" dir="auto">${item.text ?? "(no text captured)"}</p>
      ${item.url
        ? html`<a class="hsma-muted" href=${item.url} target="_blank" rel="noreferrer noopener"
            >source</a
          >`
        : nothing}
    </li>
  `;
}

export function renderHsma(props: {
  host: object;
  client: GatewayBrowserClient | null;
  connected: boolean;
  onRequestUpdate: () => void;
}): TemplateResult {
  const { host, client, connected, onRequestUpdate } = props;
  const state = getHsmaState(host);

  if (!connected) {
    return html`<div class="hsma-page"><p>Gateway not connected.</p></div>`;
  }
  if (!state.loadedAt && !state.loading) {
    configureHsmaPolling(host, client, onRequestUpdate);
  }

  const platform = state.platform;
  const lexicon = state.lexicon;

  return html`
    <div class="hsma-page">
      <header class="hsma-header">
        <h2>Hate speech monitoring</h2>
        <button
          class="hsma-refresh"
          ?disabled=${state.loading}
          @click=${() => void loadHsma(host, client, onRequestUpdate)}
        >
          ${state.loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      <section class="hsma-section">
        <h3>Waiting for a human <span class="hsma-count">${state.reviewCount}</span></h3>
        ${sectionError(state, "hsma.reviewQueue")}
        ${state.review.length === 0
          ? html`<p class="hsma-muted">
              Nothing queued. Flagged, ambiguous and committee-disagreement items appear here;
              cleared items never do.
            </p>`
          : html`<ul class="hsma-review">
              ${state.review.map(renderReviewItem)}
            </ul>`}
      </section>

      <section class="hsma-section">
        <h3>Cases</h3>
        ${sectionError(state, "hsma.cases")}
        ${state.cases.length === 0
          ? html`<p class="hsma-muted">
              No cases open. A case is a target group, a narrative and the hours worth watching.
            </p>`
          : html`<ul class="hsma-cases">
              ${state.cases.map(
                (c) => html`
                  <li class="hsma-case">
                    <div class="hsma-case-head">
                      <strong>${c.targetGroup ?? c.id}</strong>
                      <span class=${`hsma-state hsma-state--${c.state.toLowerCase()}`}
                        >${c.state}</span
                      >
                    </div>
                    ${c.narrative ? html`<p>${c.narrative}</p>` : nothing} ${renderHours(c)}
                  </li>
                `,
              )}
            </ul>`}
        ${state.crawls
          ? html`<p class="hsma-muted">
              ${state.crawls.total} crawls, ${state.crawls.baseline} of them deliberately outside
              the learned window — without those, "nothing here" and "never looked" are
              indistinguishable.
            </p>`
          : nothing}
      </section>

      <section class="hsma-section">
        <h3>Lexicon</h3>
        ${sectionError(state, "hsma.lexicon")}
        ${lexicon
          ? html`
              <p>
                <strong>${lexicon.terms}</strong> terms, <strong>${lexicon.tropes}</strong> tropes,
                <span class=${lexicon.state === "stale" ? "hsma-warn" : ""}>${lexicon.state}</span>
                ${lexicon.ageHours != null
                  ? html`<span class="hsma-muted"> · ${Math.round(lexicon.ageHours)}h old</span>`
                  : nothing}
              </p>
              <p class="hsma-muted">
                The lexicon belongs to the platform. A curator adds a term and the agent picks it up
                on the next sync; nothing is hardcoded here.
              </p>
              ${lexicon.rejected?.length
                ? html`<p class="hsma-warn">
                    ${lexicon.rejected.length} pattern(s) sent by the platform would not compile
                    here and are not being matched.
                  </p>`
                : nothing}
            `
          : html`<p class="hsma-muted">No lexicon loaded.</p>`}
      </section>

      <section class="hsma-section">
        <h3>Platform</h3>
        ${sectionError(state, "hsma.platform")}
        ${platform == null
          ? html`<p class="hsma-muted">Unknown.</p>`
          : platform.configured === false
            ? html`
                <p class="hsma-warn">${platform.reason}</p>
                <pre class="hsma-cmd">
hsma config set plugins.entries.hsma.config.platformUrl &lt;base url&gt;
hsma config set plugins.entries.hsma.config.agentKey &lt;hate_speech_scan key&gt;
hsma config set plugins.entries.hsma.config.agentId hsma-$(hostname)</pre>
                <p class="hsma-muted">
                  agentId is not optional in practice: the platform scopes idempotency on (agent_id,
                  key), so two machines omitting it share a namespace and one silently replays the
                  other's response.
                </p>
              `
            : html`
                <p>
                  <span class=${platform.reachable ? "hsma-ok" : "hsma-warn"}
                    >${platform.reachable ? "reachable" : "unreachable"}</span
                  >
                  <span class="hsma-muted"> · ${platform.url}</span>
                  ${platform.agentId
                    ? html`<span class="hsma-muted"> · ${platform.agentId}</span>`
                    : nothing}
                </p>
                ${platform.detail ? html`<p class="hsma-error">${platform.detail}</p>` : nothing}
                <p class="hsma-muted">${platform.pending ?? 0} item(s) queued to send.</p>
              `}
      </section>
    </div>
  `;
}
