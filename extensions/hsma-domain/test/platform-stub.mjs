import http from "node:http";
// A local stand-in for the Ettok platform, serving the real lexicon that the old
// Python agent had cached. ettok.net is unreachable, and the lexicon is deliberately
// not hardcoded in the agent, so without this there is nothing to classify against.
//
// This is a test fixture, not a replacement for the platform: it is read-only, serves
// two endpoints, and exists so we can prove the agent loop reaches classify.
import { DatabaseSync } from "node:sqlite";

const DB = process.argv[2] ?? "C:/xampp/htdocs/AnkEdo/data/ankedo.db";
const PORT = Number(process.argv[3] ?? 8799);

const db = new DatabaseSync(DB, { readOnly: true });

const parseJson = (raw, fallback) => {
  if (raw == null) return fallback;
  try {
    const v = JSON.parse(raw);
    return v ?? fallback;
  } catch {
    return fallback;
  }
};

// The old schema stores UUID strings; the wire contract wants numbers. Map them to
// stable small integers so verdicts referencing an id stay meaningful across restarts.
let nextId = 1;
const idMap = new Map();
const numericId = (uuid) => {
  if (!idMap.has(uuid)) idMap.set(uuid, nextId++);
  return idMap.get(uuid);
};

function terms() {
  const rows = db.prepare("SELECT * FROM lexicon_entries WHERE enabled = 1").all();
  return rows.map((r) => ({
    id: numericId(r.id),
    term: r.term,
    // The old rows often left language null; the agent asks for ar/ku, and every term
    // in this set is Arabic script, so defaulting to null would filter them all out.
    language: r.language ?? "ar",
    category: r.category ?? null,
    target_group: r.raw_target_group ?? null,
    target_group_slug: r.raw_target_group ?? null,
    severity_weight: r.severity ?? 5,
    is_regex: Boolean(r.is_regex),
    is_explicit: Boolean(r.is_explicit),
    never_flag_when: parseJson(r.never_flag_when, []),
    variants: parseJson(r.variants, []),
  }));
}

function tropes() {
  const rows = db.prepare("SELECT * FROM trope_entries WHERE enabled = 1").all();
  return rows.map((r) => {
    const activation = parseJson(r.activation, {});
    // surface_forms is [{text, register}] in the old schema and string[] in the wire
    // contract. Dropping the register loses nothing the matcher uses.
    const forms = parseJson(r.surface_forms, [])
      .map((f) => (typeof f === "string" ? f : (f?.text ?? "")))
      .filter(Boolean);
    // The old schema keeps this in a join table, not a column. Missing it makes
    // covers_groups empty, so matchedGroup is always null and a trope can only fire
    // via its activation topics -- which is exactly how the devil-worship case failed.
    const groups = db
      .prepare(
        "SELECT g.slug FROM trope_target_groups tg " +
          "JOIN target_groups g ON g.id = tg.target_group_id " +
          "WHERE tg.trope_entry_id = ?",
      )
      .all(r.id)
      .map((x) => x.slug);
    return {
      id: numericId(r.id),
      name: r.trope_id,
      description: r.implicature ?? "",
      example: forms[0] ?? null,
      target_group: null,
      target_group_slug: null,
      target_groups: Array.isArray(groups) ? groups : [],
      // post_topic_any is the old name for the activation gate. Empty must stay empty:
      // the agent reads an empty gate as "no deterministic gate yet", never "always on".
      activation_topics: activation.post_topic_any ?? [],
      surface_forms: forms,
      requires_target_group: activation.requires_target_group ?? true,
      negation_cancels: activation.negation_cancels ?? true,
      negative_examples: parseJson(r.negative_examples, [])
        .map((e) => (typeof e === "string" ? e : (e?.comment_text ?? "")))
        .filter(Boolean),
      counter_speech_examples: parseJson(r.counter_speech_examples, [])
        .map((e) => (typeof e === "string" ? e : (e?.comment_text ?? "")))
        .filter(Boolean),
      severity_weight: r.severity ?? 5,
      is_visual: Boolean(r.is_visual),
    };
  });
}

const seen = new Map();
let extraTerms = [];
let failing = false;
const received = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, body) => {
    const json = JSON.stringify(body);
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(json);
    console.log(`${req.method} ${url.pathname} -> ${code} (${json.length} bytes)`);
  };

  if (url.pathname === "/lexicon/" || url.pathname === "/lexicon") {
    const t = [...terms(), ...extraTerms];
    return send(200, { terms: t, tropes: tropes(), total: t.length });
  }
  // Write endpoints, so the outbox flush can be proved end to end rather than only
  // unit-tested. Records the Idempotency-Key and replays the stored response when the
  // same key arrives twice, which is what the real platform does.
  if (url.pathname === "/__setterms" || url.pathname === "/__fail" || url.pathname === "/__ok") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (url.pathname === "/__fail") failing = true;
      else if (url.pathname === "/__ok") failing = false;
      else {
        try {
          extraTerms = JSON.parse(body || "{}").extra ?? [];
        } catch {
          extraTerms = [];
        }
      }
      send(200, { ok: true, extra: extraTerms.length, failing });
    });
    return;
  }

  if (failing) {
    return send(503, { detail: "platform unavailable" });
  }

  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const key = req.headers["idempotency-key"] ?? "";
      const agent = req.headers["x-agent-id"] ?? "";
      const scope = `${agent}:${key}`;
      if (key && seen.has(scope)) {
        console.log(`  REPLAY ${url.pathname} key=${key}`);
        return send(200, { ...seen.get(scope), replayed: true });
      }
      let parsed = null;
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        return send(400, { detail: "invalid json" });
      }
      const accepted = {
        accepted: true,
        path: url.pathname,
        agent_id: agent,
        idempotency_key: key,
        items: Array.isArray(parsed?.gaps) ? parsed.gaps.length : 1,
      };
      if (key) seen.set(scope, accepted);
      received.push({ path: url.pathname, key, agent, body: parsed });
      send(200, accepted);
    });
    return;
  }

  if (url.pathname === "/__reset") {
    received.length = 0;
    seen.clear();
    return send(200, { reset: true });
  }

  if (url.pathname === "/__received") {
    return send(200, { count: received.length, received });
  }

  if (url.pathname === "/tropes/" || url.pathname === "/tropes") {
    const tr = tropes();
    return send(200, { tropes: tr, total: tr.length });
  }
  return send(404, { detail: "not found", path: url.pathname });
});

server.listen(PORT, "127.0.0.1", () => {
  const t = terms();
  const tr = tropes();
  console.log(`lexicon stub on http://127.0.0.1:${PORT}/`);
  console.log(`  ${t.length} terms, ${tr.length} tropes from ${DB}`);
  for (const x of t)
    console.log(`    term  ${x.term}  (explicit=${x.is_explicit}, sev=${x.severity_weight})`);
  for (const x of tr)
    console.log(
      `    trope ${x.name}  gate=[${x.activation_topics.join(", ")}] forms=${x.surface_forms.length}`,
    );
});
