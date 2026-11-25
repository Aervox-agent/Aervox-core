import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { inboxContract } from "../src/inbox-contract.js";
import { InMemoryInbox } from "../src/in-memory-inbox.js";

/**
 * 将框架无关的 InboxPort 契约套件跑在内存实现上。
 *
 * 生产 SQLite 实现在宿主包以同一套件运行，两边共用同一份用例，避免
 * 「换实现等于换 claim/ack 语义」。
 */
describe("InMemoryInbox 契约", () => {
  for (const contractCase of inboxContract()) {
    it(contractCase.name, async () => {
      await contractCase.run(new InMemoryInbox(), {
        assert: {
          equal(actual, expected, message) {
            expect(actual, message).toBe(expected);
          },
          ok(value, message) {
            expect(value, message).toBeTruthy();
          },
        },
      });
    });
  }
});

/**
 * 与 store 套件同标准：InboxPort 的每个方法都必须被至少一条用例调用。
 * 给端口新增方法而忘记补用例时，这里会指名失败。
 */
describe("InboxPort 契约覆盖自检", () => {
  it("InboxPort 的每个方法都被至少一条用例调用", () => {
    const portsSource = readFileSync(new URL("../src/ports.ts", import.meta.url), "utf8");
    const start = portsSource.indexOf("export interface InboxPort");
    const end = portsSource.indexOf("export interface DeletionGatePort");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const methods = [...portsSource.slice(start, end).matchAll(/^ {2}([a-zA-Z]+)\??\(/gm)].map(m => m[1]!);
    expect(methods.length).toBeGreaterThan(0);

    const suiteSource = readFileSync(new URL("../src/inbox-contract.ts", import.meta.url), "utf8");
    const exercised = new Set([...suiteSource.matchAll(/inbox\.([a-zA-Z]+)/g)].map(m => m[1]!));

    const uncovered = methods.filter(method => !exercised.has(method));
    expect(uncovered, `未覆盖的 InboxPort 方法: ${uncovered.join(", ")}`).toEqual([]);
  });
});
