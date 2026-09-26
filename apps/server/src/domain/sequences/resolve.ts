export class UnresolvedPlaceholder extends Error {
  constructor(
    public readonly stepIndex: number,
    public readonly key: string,
  ) {
    super(`unresolved placeholder {${key}} in step ${stepIndex}`);
    this.name = "UnresolvedPlaceholder";
  }
}

export interface ResolvedStep {
  index: number;
  resolvedVars: Record<string, string>;
  varSources: Record<string, string>;
  text: string;
}

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

export function resolveSequence(
  steps: Array<{ index: number; text: string }>,
  vars: Record<string, string> | undefined | null,
  stepVars: Record<string, Record<string, string>> | undefined | null,
): { steps: ResolvedStep[] } {
  const current: Record<string, string> = {};
  const source: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars ?? {})) {
    if (value === "") continue; // "" in vars = not provided
    current[key] = value;
    source[key] = "default";
  }
  const resolved: ResolvedStep[] = [];
  for (const step of [...steps].sort((a, b) => a.index - b.index)) {
    const sv = stepVars?.[String(step.index)] ?? {};
    for (const [key, value] of Object.entries(sv)) {
      if (value === "") continue; // "" in stepVars = no change at this step
      current[key] = value;
      source[key] = `step:${step.index}`;
    }
    const usedKeys = new Set<string>();
    let match: RegExpExecArray | null;
    PLACEHOLDER.lastIndex = 0;
    while ((match = PLACEHOLDER.exec(step.text)) !== null) {
      usedKeys.add(match[1]!);
      if (!(match[1]! in current)) {
        throw new UnresolvedPlaceholder(step.index, match[1]!);
      }
    }
    const resolvedVars: Record<string, string> = {};
    const varSources: Record<string, string> = {};
    for (const key of usedKeys) {
      resolvedVars[key] = current[key]!;
      varSources[key] = source[key]!;
    }
    resolved.push({
      index: step.index,
      resolvedVars,
      varSources,
      text: step.text.replace(PLACEHOLDER, (m, key: string) => current[key] ?? m),
    });
  }
  return { steps: resolved };
}
