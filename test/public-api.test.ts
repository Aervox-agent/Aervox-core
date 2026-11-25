import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as core from "../src/index.js";
import * as browser from "../src/browser.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("public entrypoints", () => {
  it("retains the consumer facade while hiding execution internals", () => {
    for (const name of [
      "executeTurn",
      "ControlContext",
      "HostToolRuntime",
      "InMemoryExecutionStore",
      "createOpenAICompatProvider",
      "createComposedContextBuilder",
      "decideResume",
      "createFauxProvider",
      "ModelProviderRegistry",
      "defaultModelProviderRegistry",
      "createTurnTerminator",
    ]) expect(core).toHaveProperty(name);
    for (const name of ["StepCollector", "runToolExecution", "settleToolLedger", "safeStringify", "dedupeKey"]) expect(core).not.toHaveProperty(name);
  });

  // ADR-021: the terminal approval strategy is the only difference between the
  // two entry points. It belongs to the Node entry alone; a third `./core`
  // subpath duplicated part of `/browser` without adding a distinct capability.
  it("exposes exactly two entries: the Node kernel and the neutral browser kernel", () => {
    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./browser"]);
    expect(core.CliInteractiveApprovalPolicy).toBeTypeOf("function");
    expect(browser).not.toHaveProperty("CliInteractiveApprovalPolicy");
    expect(Object.keys(browser).sort())
      .toEqual(Object.keys(core).filter(name => name !== "CliInteractiveApprovalPolicy").sort());
  });
});
