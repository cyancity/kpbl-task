import { describe, it, expect } from "vitest";
import {
  resolveSequence,
  UnresolvedPlaceholder,
} from "../src/domain/sequences/resolve.js";

const steps = (texts: string[]) =>
  texts.map((text, i) => ({ index: i + 1, text }));

describe("resolveSequence", () => {
  it("vars only: defaults apply everywhere", () => {
    const { steps: r } = resolveSequence(steps(["{a}-1", "{a}-2"]), { a: "x" }, {});
    expect(r[0]!.text).toBe("x-1");
    expect(r[1]!.text).toBe("x-2");
    expect(r[0]!.varSources.a).toBe("default");
  });

  it("stepVars override persists to later steps", () => {
    const { steps: r } = resolveSequence(steps(["{a}", "{a}", "{a}"]), { a: "x" }, {
      "2": { a: "y" },
    });
    expect(r.map((s) => s.text)).toEqual(["x", "y", "y"]);
    expect(r[2]!.varSources.a).toBe("step:2");
  });

  it("later stepVars re-override; source tracks the latest writer", () => {
    const { steps: r } = resolveSequence(steps(["{a}", "{a}", "{a}", "{a}"]), { a: "x" }, {
      "2": { a: "y" },
      "4": { a: "z" },
    });
    expect(r.map((s) => s.text)).toEqual(["x", "y", "y", "z"]);
    expect(r[3]!.varSources.a).toBe("step:4");
  });

  it("empty string in stepVars means no change; empty string in vars means unprovided", () => {
    const { steps: r } = resolveSequence(steps(["{a}"]), { a: "x" }, { "1": { a: "" } });
    expect(r[0]!.text).toBe("x");
    expect(r[0]!.varSources.a).toBe("default");
    expect(() => resolveSequence(steps(["{a}"]), { a: "" }, {})).toThrow(
      UnresolvedPlaceholder,
    );
  });

  it("reports the first offending step and key in text order", () => {
    try {
      resolveSequence(steps(["{ok}", "{one} {two}"]), { ok: "1" }, {});
      expect.unreachable();
    } catch (err) {
      const e = err as UnresolvedPlaceholder;
      expect(e.stepIndex).toBe(2);
      expect(e.key).toBe("one");
    }
  });

  it("resolvedVars only contains keys used by that step", () => {
    const { steps: r } = resolveSequence(steps(["{a}", "no vars"]), { a: "x", b: "y" }, {});
    expect(r[0]!.resolvedVars).toEqual({ a: "x" });
    expect(r[1]!.resolvedVars).toEqual({});
  });

  it("{bad-key} is literal text, not a placeholder", () => {
    const { steps: r } = resolveSequence(steps(["keep {bad-key}"]), {}, {});
    expect(r[0]!.text).toBe("keep {bad-key}");
  });

  it("stepVars keys that are not step indexes are ignored", () => {
    const { steps: r } = resolveSequence(steps(["{a}"]), { a: "x" }, { foo: { a: "z" } });
    expect(r[0]!.text).toBe("x");
  });
});
