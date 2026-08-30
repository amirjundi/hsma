// A local OpenAI-compatible endpoint that always decides to call `classify`.
//
// The point is not to test a model. It is to prove the link nothing else covers: that
// the real agent loop takes a model's tool call, dispatches it to the HSMA plugin,
// runs the lexicon and trope engines against the platform's dictionary, and returns a
// verdict. Every other layer has its own test; this is the seam between them.
//
// Deterministic on purpose. A real model may or may not choose to call the tool on any
// given turn, which makes it useless as a regression test for the wiring.
import http from "node:http";

const PORT = Number(process.argv[2] ?? 8810);
const calls = [];

function toolCallResponse(model, args) {
  return {
    id: "chatcmpl-hsma-test",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_classify_1",
              type: "function",
              function: { name: "classify", arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function textResponse(model, text) {
  return {
    id: "chatcmpl-hsma-test",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

const server = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  if (req.url === "/__calls") {
    return send(200, { count: calls.length, calls });
  }
  if (req.url?.includes("/models")) {
    return send(200, { object: "list", data: [{ id: "hsma-test", object: "model" }] });
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let payload = {};
    try {
      payload = JSON.parse(body || "{}");
    } catch {}
    const model = payload.model ?? "hsma-test";
    const messages = payload.messages ?? [];
    const tools = (payload.tools ?? []).map((t) => t?.function?.name).filter(Boolean);
    calls.push({ tools, messageCount: messages.length });

    // Once the tool has run, the loop feeds its result back as a tool message. Answer
    // with text then, or the loop would call the tool forever.
    const alreadyRan = messages.some((m) => m?.role === "tool");
    if (alreadyRan) {
      const result = messages.filter((m) => m?.role === "tool").at(-1);
      return send(200, textResponse(model, `classify returned: ${result?.content ?? "(nothing)"}`));
    }

    if (!tools.includes("classify")) {
      // Recorded rather than guessed at: if classify was never offered, the failure is
      // that the plugin's tools did not reach the model, not that the model declined.
      return send(200, textResponse(model, "ERROR: classify was not offered to the model"));
    }

    // The Phase 2 acceptance case: a pious formula under a Yazidi ceremony post.
    return send(
      200,
      toolCallResponse(model, {
        text: "اعوذ بالله من الشيطان الرجيم",
        parentPostText: "مراسم دينية إيزيدية في معبد لالش",
        targetGroups: ["yazidi"],
      }),
    );
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fake model on http://127.0.0.1:${PORT}/v1 (always calls classify)`);
});
