import { StepError } from "../types.ts";

// ---------------------------------------------------------------- small helpers

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

export function settle<T>(p: Promise<T>, onDone?: (s: Settled<T>) => void): Promise<Settled<T>> {
  return p.then(
    (value) => {
      const s: Settled<T> = { ok: true, value };
      onDone?.(s);
      return s;
    },
    (error) => {
      const s: Settled<T> = { ok: false, error };
      onDone?.(s);
      return s;
    },
  );
}

export const TIMED_OUT = Symbol("timed out");

export async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms));
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function errText(e: unknown): string {
  if (e instanceof StepError) return `${e.message} (${e.detail.join("; ")})`;
  return e instanceof Error ? e.message : String(e);
}
