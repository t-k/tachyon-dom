export type BrowserTraceEvent = {
  name: string;
  ts: number;
  dur?: number;
  ph: string;
  pid: number;
  tid: number;
};

export type BrowserTraceOperation = {
  syncMarkMs: number;
  settledMarkMs: number;
  mainThreadTaskMs: number;
  scriptEventMs: number;
  styleLayoutMs: number;
  paintMs: number;
};

const scriptEvents = new Set(["FunctionCall", "EvaluateScript", "RunMicrotasks", "EventDispatch"]);
const taskEvents = new Set(["RunTask"]);
const styleLayoutEvents = new Set(["UpdateLayoutTree", "Layout", "RecalculateStyles"]);
const paintEvents = new Set(["Paint"]);

const unionDurationMs = (
  events: readonly BrowserTraceEvent[],
  names: ReadonlySet<string>,
  start: BrowserTraceEvent,
  end: BrowserTraceEvent,
): number => {
  const intervals = events
    .filter((event) => event.pid === start.pid && event.tid === start.tid && event.ph === "X" && names.has(event.name))
    .map((event) => [Math.max(start.ts, event.ts), Math.min(end.ts, event.ts + (event.dur ?? 0))] as const)
    .filter(([from, to]) => to > from)
    .sort(([left], [right]) => left - right);
  let elapsed = 0;
  let from = 0;
  let to = 0;
  for (const [nextFrom, nextTo] of intervals) {
    if (nextFrom > to) {
      elapsed += to - from;
      from = nextFrom;
      to = nextTo;
    } else {
      to = Math.max(to, nextTo);
    }
  }
  return (elapsed + to - from) / 1000;
};

export const summarizeBrowserTrace = <Name extends string>(
  events: readonly BrowserTraceEvent[],
  operationNames: readonly Name[],
): Record<Name, BrowserTraceOperation> => {
  const operations = {} as Record<Name, BrowserTraceOperation>;
  for (const name of operationNames) {
    const start = events.find((event) => event.name === `tachyon:${name}:start` && event.ph === "I");
    const sync = events.find((event) => event.name === `tachyon:${name}:sync` && event.ph === "I");
    const settled = events.find((event) => event.name === `tachyon:${name}:settled` && event.ph === "I");
    if (!start || !sync || !settled) throw new Error(`Missing trace mark for ${name}.`);
    if (start.ts > sync.ts || sync.ts > settled.ts) throw new Error(`Trace marks for ${name} are out of order.`);
    operations[name] = {
      syncMarkMs: (sync.ts - start.ts) / 1000,
      settledMarkMs: (settled.ts - start.ts) / 1000,
      mainThreadTaskMs: unionDurationMs(events, taskEvents, start, settled),
      scriptEventMs: unionDurationMs(events, scriptEvents, start, settled),
      styleLayoutMs: unionDurationMs(events, styleLayoutEvents, start, settled),
      paintMs: unionDurationMs(events, paintEvents, start, settled),
    };
  }
  return operations;
};
