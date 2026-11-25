import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as core from "../src/index.js";
import * as browser from "../src/browser.js";
import * as ports from "../src/ports.js";

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
  // Node and browser entries. It belongs to the Node entry alone; the removed
  // `./core` subpath duplicated part of `/browser` without adding a capability.
  it("exposes the Node kernel, the neutral browser kernel and the contract entry", () => {
    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./browser", "./ports"]);
    expect(core.CliInteractiveApprovalPolicy).toBeTypeOf("function");
    expect(browser).not.toHaveProperty("CliInteractiveApprovalPolicy");
    expect(Object.keys(browser).sort())
      .toEqual(Object.keys(core).filter(name => name !== "CliInteractiveApprovalPolicy").sort());
  });

  // A host implementing a port must not have to pull in the executor, the
  // providers or the in-memory fixtures just to name the contract.
  it("keeps the contract entry free of implementation and a subset of the neutral entry", () => {
    expect(Object.keys(ports).sort()).toEqual(["CompactionError", "LeaseLostError"]);
    for (const [name, value] of Object.entries(ports)) {
      expect(browser, `contract symbol ${name} must stay available on /browser`).toHaveProperty(name, value);
    }
    for (const name of ["executeTurn", "ControlContext", "HostToolRuntime", "InMemoryExecutionStore", "createOpenAICompatProvider"])
      expect(ports, `contract entry must not expose implementation ${name}`).not.toHaveProperty(name);
  });
});
