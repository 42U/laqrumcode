import { inspect } from "node:util";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof LEVELS;

const currentLevel: Level = (process.env.KONGCODE_LOG_LEVEL as Level) ?? "warn";

if (currentLevel === "debug") {
  console.warn("[kongcode] KONGCODE_LOG_LEVEL=debug — logs may contain user prompts and query data. Do not use in shared environments.");
}

/**
 * Default console depth is 2, which collapses nested `.cause.cause` chains to
 * `[Object]`. Errors thrown across SurrealDB / async hops routinely carry a
 * `.cause` (and the cause carries its own cause), so we re-format any Error
 * argument with depth=6 before handing it to the underlying console method.
 * Non-Error args are passed through untouched so console formatting (printf
 * %s/%d substitution, colorization, etc.) still works for prefix strings.
 *
 * MED M6 (Round 6): cap string and array length inside the inspect output so
 * a single SurrealDB error carrying a multi-KB query payload (or a giant
 * embedding array on a wrapped error) cannot blow up daemon.log with
 * multi-megabyte lines that destroy log rotation and grepability. The 4096
 * char / 100 element budget keeps `.cause.cause` chains readable for forensic
 * work while ensuring no single log line dominates the file.
 */
function expandErrors(args: unknown[]): unknown[] {
  return args.map(a => {
    if (!(a instanceof Error)) return a;
    // R7 F4: inspect() can itself throw on pathological values — a Proxy with
    // a throwing get/getOwnPropertyDescriptor, a getter that throws, a
    // circular structure deeper than depth=6 that hits an internal limit.
    // If inspect blows up here it propagates out of every log.warn/log.error
    // call (including swallow.warn from the error paths themselves), masking
    // the original error with an inspect failure. Fall back to String(err)
    // so the log line still records something rather than crashing the call.
    try {
      return inspect(a, { depth: 6, maxStringLength: 4096, maxArrayLength: 100 });
    } catch {
      return String(a);
    }
  });
}

export const log = {
  error: (...args: unknown[]) => { if (LEVELS[currentLevel] >= LEVELS.error) console.error("[kongcode]", ...expandErrors(args)); },
  warn: (...args: unknown[]) => { if (LEVELS[currentLevel] >= LEVELS.warn) console.warn("[kongcode]", ...expandErrors(args)); },
  info: (...args: unknown[]) => { if (LEVELS[currentLevel] >= LEVELS.info) console.info("[kongcode]", ...expandErrors(args)); },
  debug: (...args: unknown[]) => { if (LEVELS[currentLevel] >= LEVELS.debug) console.debug("[kongcode]", ...expandErrors(args)); },
};
