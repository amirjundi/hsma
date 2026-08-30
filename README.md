# HSMA — Hate Speech Monitoring Agent

HSMA watches Arabic and Kurdish social media for speech targeting Iraqi minorities —
Yazidis, Christians and Assyrians, Shabak, Kaka'i, Sabian-Mandaeans, Turkmen, Faili
Kurds, Baháʼís, Kurds. It collects, judges, keeps its own record, and puts findings in
front of a human being who decides what happens next.

It is a monitoring agent, not an assistant. It runs on a schedule it works out for
itself, decides which pages are worth returning to, and says plainly what it has not
looked at.

Built on [OpenClaw](https://github.com/openclaw/openclaw) (MIT, © 2026 OpenClaw
Foundation), which supplies the agent loop, model providers, the Gateway and the
Control UI. HSMA replaces the personal-assistant persona with a monitoring one and
adds the judgement.

## How it judges

**In context.** `اعوذ بالله من الشيطان الرجيم` is an ordinary pious phrase. Under a post
about a Yazidi ceremony at Lalish it invokes the devil-worship libel. The same words are
a different act in a different place, so a comment is always judged against what it
replies to.

**Never on words alone.** `نجس` about drinking water is a complaint about water.
`الخونة` in an argument about the government is ordinary Iraqi political speech. A trope
fires only when its activation condition is met.

**Not against the defenders.** Counter-speech reproduces the exact words it condemns,
and the person quoting a libel is usually the person rejecting it. Flagging them is the
specific harm this project can cause, so `never_flag_when` and negation cues are
enforced in code rather than left to the model.

**Mockery, not just slurs.** Ridiculing a pilgrimage, a rite, a way of dressing is most
of what the survey found, and none of it appears in any dictionary. A keyword list
scores well on the cases that were never the problem.

## What it decides for itself

Crawl windows come from an hour-of-day histogram of when flagged content was _posted_,
not when it was collected. A fifth of crawls deliberately fall outside those windows,
because otherwise the record describes the crawler's habits rather than reality — and
`case_status` reports that gap instead of hiding it.

Cases move `Active → Cooling → Dormant` on their own. Waking one needs a human, always:
a trend spike is exactly when the agent is most confident and most likely to be
reacting to a single loud day.

## Tools

| Tool             | What it answers                                |
| ---------------- | ---------------------------------------------- |
| `classify`       | Is this hate speech, given what it replies to? |
| `lexicon_status` | What am I matching with, and how old is it?    |
| `case_open`      | Start a monitoring campaign                    |
| `case_status`    | State, findings, learned hours, coverage gaps  |
| `review_queue`   | What is waiting for a human?                   |
| `next_crawl`     | Should I be running right now, and where?      |

## The lexicon is not in this repository

It belongs to the Ettok platform. A curator adds a term in the dashboard and the agent
picks it up on the next sync. Nothing here hardcodes a term, and the agent may only
_propose_ additions, through `lexicon-gaps/`. It contributes without the authority to
rewrite its own rules — an agent that expands its own dictionary from its own findings
will eventually justify anything.

Verdicts record how stale the dictionary was when they were made. Recall degrades
silently against an old lexicon, and a reviewer reading a report months later needs to
know what judged it.

## Install

Requires **Node >=22.22.3 <23, >=24.15 <25, or >=25.9** — a disjunction, not a floor.
Node 23.x and 24.11 are excluded despite being numerically higher than 22.22.3.

This is a pnpm workspace; plain `npm install` at the root is not supported.

```bash
git clone https://github.com/amirjundi/hsma.git
cd hsma
pnpm install
pnpm build
npm install -g . --allow-scripts=hsma

hsma onboard
```

`onboard` configures a model provider and seeds the workspace with HSMA's persona.
Then point it at the platform:

```bash
hsma config set plugins.entries.hsma.config.platformUrl https://ettok.net/api/hermes/
hsma config set plugins.entries.hsma.config.agentKey <key with the hate_speech_scan scope>
hsma config set plugins.entries.hsma.config.agentId hsma-$(hostname)
hsma config set plugins.entries.hsma.config.databasePath ~/.hsma/evidence.db

hsma gateway run
```

`agentId` is not optional in practice: the platform scopes idempotency on
`(agent_id, key)`, so two machines omitting it share a namespace and one silently
replays the other's response.

State lives in `~/.hsma`. An existing `~/.openclaw` is inherited when `~/.hsma`
does not exist yet, so upgrading in place does not orphan a working config — the
gateway token lives in there, and losing it reads as a broken install rather than a
moved directory.

### Collection

Collection uses [Camoufox](https://camoufox.com), a hardened Firefox fork — not
OpenClaw's bundled browser, which drives Chromium over CDP with no anti-detection. CDP
is exactly what social platforms fingerprint, and a fingerprinted worker account is a
banned one.

```bash
cd extensions/hsma-domain && npm install camoufox && npx camoufox fetch
```

The bundled Chromium plugin is already disabled by default, so there is nothing to
turn off.

Everything except collection works without a browser. If Camoufox will not start, the
agent classifies as normal and says so plainly rather than refusing to start.

## Security

Everything the agent reads is written by strangers, and some of them will try to talk it
into something. Content under analysis is data: it cannot change settings, authorise
anything, or issue instructions. That boundary lives in the persona and in the tool
surface, which is deliberately small and separates what reads from what writes.

The evidence store holds posts and comments naming real people. It is gitignored, and it
should stay that way.

## Tests

```bash
cd extensions/hsma-domain
npm test          # unit tests for the judgement
npm run test:e2e  # end-to-end against a stub platform over real HTTP
```

The normaliser is checked against fixtures generated from the platform's own canonical
fold, so the two cannot drift apart silently. If the folding diverges, matching quietly
stops working for terms containing yeh or alef maksura and nothing errors.

## Relationship to upstream

This is a thin fork. The agent loop, providers, Gateway and Control UI are OpenClaw's
and are deliberately left alone, so upstream fixes stay cheap to merge. HSMA changes
the package identity, the config directory, the bundled workspace persona and the CLI
name, and adds `extensions/hsma-domain`.

Internal identifiers — the `OPENCLAW_*` environment variables, the plugin manifest key,
daemon service markers, protocol constants — keep their names on purpose. Renaming them
would conflict with every upstream merge and change nothing an operator sees.

This fork was made from a depth-1 clone, so it carries one upstream commit rather
than OpenClaw's full history. That keeps the repository small, but merging upstream
needs the history fetched first -- a plain `git fetch` against a shallow clone will
not give you a merge base:

```bash
git remote add upstream https://github.com/openclaw/openclaw.git
git fetch --unshallow upstream        # once; downloads the real history
git fetch upstream && git merge upstream/main
```

## Licence

MIT. Built on OpenClaw (MIT, © 2026 OpenClaw Foundation) by Peter Steinberger and the
OpenClaw community; see `LICENSE` and `THIRD_PARTY_NOTICES.md`, which are retained
unchanged.
