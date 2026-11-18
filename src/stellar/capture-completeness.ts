/**
 * Capture completeness metadata for analytical aggregate series.
 *
 * Annotates analytical reducers (such as volume series and resolution latency)
 * with ledger range and capture gap metadata to prevent partial or windowed
 * captures from being presented as global market totals.
 *
 * Invariants:
 * - Ledger bounds are integers; null when no events or explicit range exist.
 * - Gaps are sorted ascending by starting ledger with non-negative missed counts.
 * - An aggregate series is complete (`isComplete = true`) ONLY when explicitly asserted
 *   complete by the caller AND free of uncaptured gaps.
 * - Partial captures yield `globalMarketTotals: null` to prevent presenting incomplete
 *   windows as global market totals.
 */

export interface CaptureGap {
  /** Inclusive starting ledger of the uncaptured gap. */
  fromLedger: number;
  /** Inclusive ending ledger of the uncaptured gap. */
  toLedger: number;
  /** Total number of missing/uncaptured ledgers in this gap. */
  missedLedgers: number;
}

export interface LedgerRange {
  /** Inclusive earliest ledger, or null if no ledgers/events observed. */
  fromLedger: number | null;
  /** Inclusive latest ledger, or null if no ledgers/events observed. */
  toLedger: number | null;
}

export interface CaptureCompleteness {
  /** Inclusive starting ledger of the captured series, or null if empty. */
  startLedger: number | null;
  /** Inclusive ending ledger of the captured series, or null if empty. */
  endLedger: number | null;
  /** Ledger range object covering fromLedger to toLedger. */
  ledgerRange: LedgerRange;
  /** Known or detected gaps in the captured ledger sequence. */
  gaps: CaptureGap[];
  /** True if any uncaptured gaps exist within the series range. */
  hasGaps: boolean;
  /** Total count of missed ledgers across all gaps. */
  totalMissedLedgers: number;
  /**
   * True only if the capture represents a verified complete, gap-free historical series.
   * False for partial captures, windowed lookbacks, or captures with gaps.
   */
  isComplete: boolean;
  /**
   * True if the capture is partial (windowed lookback, incomplete, or contains gaps).
   * Inverse of `isComplete`.
   */
  isPartial: boolean;
}

export interface CaptureGapInput {
  fromLedger?: number;
  toLedger?: number;
  from?: number;
  to?: number;
  missedLedgers?: number;
}

export interface CaptureCompletenessOptions {
  /** Expected starting ledger of the capture range (inclusive). */
  fromLedger?: number;
  /** Expected ending ledger of the capture range (inclusive). */
  toLedger?: number;
  /** Alias for fromLedger. */
  startLedger?: number;
  /** Alias for toLedger. */
  endLedger?: number;
  /** Known uncaptured gaps in the ledger sequence. */
  gaps?: readonly CaptureGapInput[];
  /** Alias for gaps. */
  knownGaps?: readonly CaptureGapInput[];
  /**
   * Explicit assertion of whether this series represents a complete historical capture
   * (e.g. from contract creation to tip).
   * Defaults to false so windowed captures are not presented as global market totals.
   */
  isComplete?: boolean;
  /**
   * If true, throws an `IncompleteCaptureError` if the capture is partial or contains gaps.
   * Prevents partial captures from being presented as global market totals.
   */
  requireComplete?: boolean;
}

/**
 * Thrown when an aggregate series is required to be complete (e.g. `requireComplete: true`
 * or `assertCompleteCapture()`) but the capture is partial or contains gaps.
 */
export class IncompleteCaptureError extends Error {
  readonly startLedger: number | null;
  readonly endLedger: number | null;
  readonly gaps: CaptureGap[];
  readonly totalMissedLedgers: number;

  constructor(message: string, completeness?: Partial<CaptureCompleteness>) {
    super(message);
    this.name = "IncompleteCaptureError";
    this.startLedger = completeness?.startLedger ?? null;
    this.endLedger = completeness?.endLedger ?? null;
    this.gaps = completeness?.gaps ?? [];
    this.totalMissedLedgers = completeness?.totalMissedLedgers ?? 0;
  }
}

/**
 * Assert that a series result represents a complete historical capture without gaps.
 * Throws `IncompleteCaptureError` if partial or containing gaps.
 */
export function assertCompleteCapture(result: { completeness: CaptureCompleteness }): void {
  if (!result || !result.completeness || !result.completeness.isComplete) {
    const gaps = result?.completeness?.gaps ?? [];
    const totalMissed = result?.completeness?.totalMissedLedgers ?? 0;
    const gapDetail = gaps.length > 0 ? ` (${gaps.length} gap(s), ${totalMissed} missed ledger(s))` : "";
    throw new IncompleteCaptureError(
      `Cannot present partial capture as global market totals: series capture is incomplete${gapDetail}`,
      result?.completeness,
    );
  }
}

/**
 * Extract observed min/max ledgers and derive capture completeness metadata.
 */
export function computeCaptureCompleteness(
  events: readonly unknown[] | null | undefined,
  options?: CaptureCompletenessOptions,
): CaptureCompleteness {
  let minObserved: number | null = null;
  let maxObserved: number | null = null;

  if (events && Array.isArray(events)) {
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      const l = (event as { ledger?: unknown }).ledger;
      if (typeof l === "number" && Number.isFinite(l) && l >= 0) {
        const ledger = Math.trunc(l);
        if (minObserved === null || ledger < minObserved) minObserved = ledger;
        if (maxObserved === null || ledger > maxObserved) maxObserved = ledger;
      }
    }
  }

  const optFrom = options?.fromLedger ?? options?.startLedger;
  const optTo = options?.toLedger ?? options?.endLedger;

  const startLedger =
    typeof optFrom === "number" && Number.isFinite(optFrom)
      ? Math.trunc(optFrom)
      : minObserved;

  const endLedger =
    typeof optTo === "number" && Number.isFinite(optTo)
      ? Math.trunc(optTo)
      : maxObserved;

  if (startLedger !== null && endLedger !== null && startLedger > endLedger) {
    throw new Error(`Invalid ledger range: startLedger (${startLedger}) cannot exceed endLedger (${endLedger})`);
  }

  const rawGaps = options?.gaps ?? options?.knownGaps ?? [];
  const gaps: CaptureGap[] = [];

  for (const g of rawGaps) {
    if (!g || typeof g !== "object") continue;
    const f = g.fromLedger ?? g.from;
    const t = g.toLedger ?? g.to;
    if (typeof f === "number" && Number.isFinite(f) && typeof t === "number" && Number.isFinite(t)) {
      const fromLedger = Math.trunc(f);
      const toLedger = Math.trunc(t);
      if (fromLedger > toLedger) {
        throw new Error(`Invalid gap range: fromLedger (${fromLedger}) cannot exceed toLedger (${toLedger})`);
      }
      const missed =
        typeof g.missedLedgers === "number" && Number.isFinite(g.missedLedgers) && g.missedLedgers > 0
          ? Math.trunc(g.missedLedgers)
          : Math.max(1, toLedger - fromLedger + 1);
      gaps.push({ fromLedger, toLedger, missedLedgers: missed });
    }
  }

  gaps.sort((a, b) => a.fromLedger - b.fromLedger || a.toLedger - b.toLedger);
  const hasGaps = gaps.length > 0;
  const totalMissedLedgers = gaps.reduce((sum, g) => sum + g.missedLedgers, 0);

  // A capture is only complete if explicitly asserted complete AND containing no gaps
  const isComplete = !hasGaps && options?.isComplete === true;
  const isPartial = !isComplete;

  const completeness: CaptureCompleteness = {
    startLedger,
    endLedger,
    ledgerRange: {
      fromLedger: startLedger,
      toLedger: endLedger,
    },
    gaps,
    hasGaps,
    totalMissedLedgers,
    isComplete,
    isPartial,
  };

  if (options?.requireComplete && !isComplete) {
    const gapDetail = hasGaps ? ` (${gaps.length} gap(s), ${totalMissedLedgers} missed ledger(s))` : "";
    throw new IncompleteCaptureError(
      `Cannot present partial capture as global market totals: series capture is incomplete${gapDetail}`,
      completeness,
    );
  }

  return completeness;
}
