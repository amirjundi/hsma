/**
 * The browser is the hardest part of the system to get running, and it must not take
 * the rest down with it.
 *
 * On the operator's machine the Python agent could not launch a browser for days.
 * Classification, the dashboard and the platform client all worked; collection did
 * not. An agent that refuses to start because Firefox is missing is far less useful
 * than one that classifies and says plainly that the browser is broken.
 */
import { describe, expect, it } from "vitest";
import { BrowserUnavailable, probe } from "../src/browser.js";

describe("a missing browser is reported, not fatal", () => {
  it("probe answers rather than throwing", async () => {
    // Camoufox is not installed here. The probe must still return a result, because
    // "can collection run?" is a question the agent has to be able to answer.
    const result = await probe();

    expect(typeof result.ok).toBe("boolean");
    expect(result.detail).toBeTruthy();
  });

  it("names the command that fixes it", async () => {
    const result = await probe();

    if (!result.ok) {
      // "It does not work" is not an answer. The Python agent's repair told the
      // operator to run `camoufox sync` and could not run it itself.
      expect(result.detail).toMatch(/camoufox/i);
    }
  });

  it("BrowserUnavailable is distinguishable from any other failure", () => {
    // Collection catching every exception the same way is how a missing browser and a
    // banned account came to look identical in the logs.
    const err = new BrowserUnavailable("not installed");

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("BrowserUnavailable");
  });
});

describe("the rest of the agent does not depend on it", () => {
  it("importing the browser module does not require a browser", async () => {
    // Lazily imported inside launch(), so a machine with no Camoufox can still
    // classify, hold cases, and talk to the platform.
    const module = await import("../src/browser.js");

    expect(module.launch).toBeTypeOf("function");
    expect(module.probe).toBeTypeOf("function");
  });
});
