import type { Direction } from "../api/types.js";
import type { MoveTelemetryRecord } from "../persistence/types.js";
import { canonicalStateKey } from "../search/state-key.js";
import type {
  OfficialReplay,
  OfficialReplayResult,
} from "./replay-corpus.js";

// V4 distinguishes deterministic root-safety overrides from statistical risk
// overrides. Both remain auditable but are excluded from policy-prior
// training, because their visit distributions still allocate probability to
// an action the final arbiter rejected. Never mix target versions as identical
// data.
export const PUCT_POLICY_TARGET_VERSION = "puct-policy-target-v4" as const;

export type PuctPolicyExclusionReason =
  | "search-not-used"
  | "fallback-protected"
  | "no-root-visits"
  | "selected-move-unvisited"
  | "root-safety-overridden"
  | "root-risk-overridden";

export interface PuctActionTarget {
  move: Direction;
  visits: number;
  probability: number;
  meanValue: number;
  outcomeCount: number;
  prior?: number;
}

export interface PuctPolicyTarget {
  targetVersion: typeof PUCT_POLICY_TARGET_VERSION;
  telemetryEventId: string;
  recordedAt: string;
  gameId: string;
  turn: number;
  snakeId: string;
  snakeName: string;
  stateKey: string;
  modelVersion: string;
  selectedMove: Direction;
  fallbackMove: Direction;
  outcome: 0 | 0.5 | 1;
  usedSearch: boolean;
  fallbackProtected: boolean;
  rootSafetyOverridden: boolean;
  deadlineReached: boolean;
  iterations: number;
  priorVisits: number;
  reusedTree: boolean;
  workersRequested: number;
  workersCompleted: number;
  totalVisits: number;
  policyEligible: boolean;
  exclusionReasons: readonly PuctPolicyExclusionReason[];
  actions: readonly PuctActionTarget[];
}

function outcomeForSnake(
  snakeId: string,
  result: Readonly<OfficialReplayResult>,
): 0 | 0.5 | 1 {
  if (result.isDraw) return 0.5;
  return result.winnerId === snakeId ? 1 : 0;
}

function finiteNonNegative(value: number, description: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${description} must be a finite non-negative number`);
  }
}

function validateMoveRecord(record: Readonly<MoveTelemetryRecord>): void {
  if (record.gameId !== record.state.game.id || record.turn !== record.state.turn) {
    throw new Error("Move telemetry identity does not match its state");
  }
  const seen = new Set<Direction>();
  for (const action of record.search.rootStatistics) {
    if (seen.has(action.move)) {
      throw new Error(
        `Duplicate root move ${action.move} for ${record.gameId} turn ${record.turn}`,
      );
    }
    seen.add(action.move);
    if (!Number.isSafeInteger(action.visits) || action.visits < 0) {
      throw new Error("Root visits must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(action.outcomeCount) || action.outcomeCount < 0) {
      throw new Error("Root outcomeCount must be a non-negative safe integer");
    }
    if (!Number.isFinite(action.meanValue)) {
      throw new Error("Root meanValue must be finite");
    }
    if (action.prior !== undefined) {
      finiteNonNegative(action.prior, "Root prior");
    }
  }
}

function targetForMove(
  record: Readonly<MoveTelemetryRecord>,
  result: Readonly<OfficialReplayResult>,
): PuctPolicyTarget {
  validateMoveRecord(record);
  const totalVisits = record.search.rootStatistics.reduce(
    (sum, action) => sum + action.visits,
    0,
  );
  if (!Number.isSafeInteger(totalVisits)) {
    throw new Error("Total root visits exceed the safe integer range");
  }

  const exclusionReasons: PuctPolicyExclusionReason[] = [];
  if (!record.search.usedSearch) exclusionReasons.push("search-not-used");
  if (record.search.fallbackProtected) {
    exclusionReasons.push("fallback-protected");
  }
  if (totalVisits === 0) exclusionReasons.push("no-root-visits");
  const selected = record.search.rootStatistics.find(
    (action) => action.move === record.finalMove,
  );
  if (selected === undefined || selected.visits === 0) {
    exclusionReasons.push("selected-move-unvisited");
  }
  const rootSafetyOverridden = record.search.rootSafety?.overridden ?? false;
  const maximumVisits = record.search.rootStatistics.reduce(
    (maximum, action) => Math.max(maximum, action.visits),
    0,
  );
  if (rootSafetyOverridden) {
    exclusionReasons.push("root-safety-overridden");
  } else if (
    record.search.usedSearch &&
    !record.search.fallbackProtected &&
    selected !== undefined &&
    selected.visits > 0 &&
    selected.visits < maximumVisits
  ) {
    // A risk override intentionally contradicts the visit distribution. Do not
    // train the policy prior to reproduce the visit leader that was vetoed.
    exclusionReasons.push("root-risk-overridden");
  }

  return {
    targetVersion: PUCT_POLICY_TARGET_VERSION,
    telemetryEventId: record.eventId,
    recordedAt: record.recordedAt,
    gameId: record.gameId,
    turn: record.turn,
    snakeId: record.state.you.id,
    snakeName: record.state.you.name,
    stateKey: record.stateKey,
    modelVersion: record.modelVersion,
    selectedMove: record.finalMove,
    fallbackMove: record.fallbackMove,
    outcome: outcomeForSnake(record.state.you.id, result),
    usedSearch: record.search.usedSearch,
    fallbackProtected: record.search.fallbackProtected,
    rootSafetyOverridden,
    deadlineReached: record.search.deadlineReached,
    iterations: record.search.iterations,
    priorVisits: record.search.priorVisits,
    reusedTree: record.search.reusedTree,
    workersRequested: record.search.workersRequested,
    workersCompleted: record.search.workersCompleted,
    totalVisits,
    policyEligible: exclusionReasons.length === 0,
    exclusionReasons,
    actions: record.search.rootStatistics.map((action) => ({
      move: action.move,
      visits: action.visits,
      probability: totalVisits === 0 ? 0 : action.visits / totalVisits,
      meanValue: action.meanValue,
      outcomeCount: action.outcomeCount,
      ...(action.prior === undefined ? {} : { prior: action.prior }),
    })),
  };
}

/**
 * Materializes auditable PUCT policy targets without silently dropping weak
 * searches. Consumers may train only from records where policyEligible=true.
 */
export function puctPolicyTargets(
  records: readonly MoveTelemetryRecord[],
  result: Readonly<OfficialReplayResult>,
): PuctPolicyTarget[] {
  const keys = new Set<string>();
  return [...records]
    .sort((a, b) =>
      a.turn - b.turn ||
      a.state.you.id.localeCompare(b.state.you.id) ||
      a.recordedAt.localeCompare(b.recordedAt)
    )
    .map((record) => {
      const key = `${record.gameId}\u0000${record.turn}\u0000${record.state.you.id}`;
      if (keys.has(key)) {
        throw new Error(
          `Duplicate move telemetry for ${record.gameId} turn ${record.turn} snake ${record.state.you.id}`,
        );
      }
      keys.add(key);
      return targetForMove(record, result);
    });
}

export function serializePuctPolicyTargets(
  targets: readonly PuctPolicyTarget[],
): string {
  if (targets.length === 0) return "";
  return `${targets.map((target) => JSON.stringify(target)).join("\n")}\n`;
}

const DIRECTIONS = new Set<string>(["up", "down", "left", "right"]);
const EXCLUSION_REASONS = new Set<string>([
  "search-not-used",
  "fallback-protected",
  "no-root-visits",
  "selected-move-unvisited",
  "root-safety-overridden",
  "root-risk-overridden",
]);

function object(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${description}`);
  }
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown, description: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${description} must be a non-negative safe integer`);
  }
  return Number(value);
}

function finite(value: unknown, description: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${description} must be finite`);
  }
  return value;
}

function parsePuctPolicyTarget(value: unknown): PuctPolicyTarget {
  const target = object(value, "PUCT policy target");
  const stringFields = [
    "telemetryEventId",
    "recordedAt",
    "gameId",
    "snakeId",
    "snakeName",
    "stateKey",
    "modelVersion",
  ] as const;
  if (
    target.targetVersion !== PUCT_POLICY_TARGET_VERSION ||
    stringFields.some((field) =>
      typeof target[field] !== "string" || target[field].length === 0
    ) ||
    !Number.isFinite(Date.parse(String(target.recordedAt))) ||
    !DIRECTIONS.has(String(target.selectedMove)) ||
    !DIRECTIONS.has(String(target.fallbackMove)) ||
    !new Set([0, 0.5, 1]).has(Number(target.outcome)) ||
    typeof target.usedSearch !== "boolean" ||
    typeof target.fallbackProtected !== "boolean" ||
    typeof target.rootSafetyOverridden !== "boolean" ||
    typeof target.deadlineReached !== "boolean" ||
    typeof target.reusedTree !== "boolean" ||
    typeof target.policyEligible !== "boolean"
  ) {
    throw new Error("Invalid PUCT policy target identity or status");
  }
  const turn = nonNegativeInteger(target.turn, "turn");
  const iterations = nonNegativeInteger(target.iterations, "iterations");
  const priorVisits = nonNegativeInteger(target.priorVisits, "priorVisits");
  const workersRequested = nonNegativeInteger(
    target.workersRequested,
    "workersRequested",
  );
  const workersCompleted = nonNegativeInteger(
    target.workersCompleted,
    "workersCompleted",
  );
  const totalVisits = nonNegativeInteger(target.totalVisits, "totalVisits");
  if (
    !Array.isArray(target.exclusionReasons) ||
    !target.exclusionReasons.every((reason) =>
      typeof reason === "string" && EXCLUSION_REASONS.has(reason)
    ) ||
    target.policyEligible !== (target.exclusionReasons.length === 0) ||
    !Array.isArray(target.actions)
  ) {
    throw new Error("Invalid PUCT policy target eligibility");
  }
  const exclusionReasons = target.exclusionReasons as PuctPolicyExclusionReason[];

  const moves = new Set<string>();
  const actions = target.actions.map((value, index): PuctActionTarget => {
    const action = object(value, `PUCT action ${index}`);
    const move = String(action.move);
    if (!DIRECTIONS.has(move) || moves.has(move)) {
      throw new Error("Invalid or duplicate PUCT action move");
    }
    moves.add(move);
    const visits = nonNegativeInteger(action.visits, "action.visits");
    const probability = finite(action.probability, "action.probability");
    if (probability < 0 || probability > 1) {
      throw new Error("action.probability must be between zero and one");
    }
    const prior = action.prior === undefined
      ? undefined
      : finite(action.prior, "action.prior");
    if (prior !== undefined && prior < 0) {
      throw new Error("action.prior must be non-negative");
    }
    return {
      move: move as Direction,
      visits,
      probability,
      meanValue: finite(action.meanValue, "action.meanValue"),
      outcomeCount: nonNegativeInteger(
        action.outcomeCount,
        "action.outcomeCount",
      ),
      ...(prior === undefined ? {} : { prior }),
    };
  });
  const visitSum = actions.reduce((sum, action) => sum + action.visits, 0);
  const probabilitySum = actions.reduce(
    (sum, action) => sum + action.probability,
    0,
  );
  if (
    visitSum !== totalVisits ||
    (totalVisits === 0 && probabilitySum !== 0) ||
    (totalVisits > 0 && Math.abs(probabilitySum - 1) > 1e-9) ||
    actions.some((action) =>
      Math.abs(
        action.probability -
          (totalVisits === 0 ? 0 : action.visits / totalVisits),
      ) > 1e-9
    )
  ) {
    throw new Error("PUCT action totals do not match totalVisits");
  }
  const expectedReasons: PuctPolicyExclusionReason[] = [];
  if (!target.usedSearch) expectedReasons.push("search-not-used");
  if (target.fallbackProtected) expectedReasons.push("fallback-protected");
  if (totalVisits === 0) expectedReasons.push("no-root-visits");
  const selected = actions.find((action) => action.move === target.selectedMove);
  if (selected === undefined || selected.visits === 0) {
    expectedReasons.push("selected-move-unvisited");
  }
  const maximumVisits = actions.reduce(
    (maximum, action) => Math.max(maximum, action.visits),
    0,
  );
  if (target.rootSafetyOverridden) {
    expectedReasons.push("root-safety-overridden");
  } else if (
    target.usedSearch &&
    !target.fallbackProtected &&
    selected !== undefined &&
    selected.visits > 0 &&
    selected.visits < maximumVisits
  ) {
    expectedReasons.push("root-risk-overridden");
  }
  if (
    expectedReasons.length !== exclusionReasons.length ||
    expectedReasons.some((reason, index) =>
      exclusionReasons[index] !== reason
    )
  ) {
    throw new Error("PUCT exclusion reasons do not match search diagnostics");
  }

  return {
    targetVersion: PUCT_POLICY_TARGET_VERSION,
    telemetryEventId: String(target.telemetryEventId),
    recordedAt: String(target.recordedAt),
    gameId: String(target.gameId),
    turn,
    snakeId: String(target.snakeId),
    snakeName: String(target.snakeName),
    stateKey: String(target.stateKey),
    modelVersion: String(target.modelVersion),
    selectedMove: String(target.selectedMove) as Direction,
    fallbackMove: String(target.fallbackMove) as Direction,
    outcome: Number(target.outcome) as 0 | 0.5 | 1,
    usedSearch: target.usedSearch,
    fallbackProtected: target.fallbackProtected,
    rootSafetyOverridden: target.rootSafetyOverridden,
    deadlineReached: target.deadlineReached,
    iterations,
    priorVisits,
    reusedTree: target.reusedTree,
    workersRequested,
    workersCompleted,
    totalVisits,
    policyEligible: target.policyEligible,
    exclusionReasons,
    actions,
  };
}

export function parsePuctPolicyTargetsJsonl(text: string): PuctPolicyTarget[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .flatMap((line, index) => {
      if (line.length === 0) return [];
      try {
        return [parsePuctPolicyTarget(JSON.parse(line) as unknown)];
      } catch (error) {
        const detail = error instanceof Error ? error.message : "invalid JSON";
        throw new Error(`Invalid PUCT target line ${index + 1}: ${detail}`);
      }
    });
}

/** Verifies that target identities and canonical states belong to the replay. */
export function validatePuctPolicyTargetsForReplay(
  targets: readonly PuctPolicyTarget[],
  replay: Readonly<OfficialReplay>,
): void {
  const seen = new Set<string>();
  const states = new Map(replay.states.map((state) => [state.turn, state]));
  for (const target of targets) {
    const key = `${target.turn}\u0000${target.snakeId}`;
    if (seen.has(key)) {
      throw new Error(
        `Duplicate PUCT target for ${target.gameId} turn ${target.turn} snake ${target.snakeId}`,
      );
    }
    seen.add(key);
    if (target.gameId !== replay.metadata.id) {
      throw new Error(`PUCT target belongs to a different game ${target.gameId}`);
    }
    const state = states.get(target.turn);
    const snake = state?.board.snakes.find((item) => item.id === target.snakeId);
    if (state === undefined || snake === undefined) {
      throw new Error(
        `PUCT target has no replay state for turn ${target.turn} snake ${target.snakeId}`,
      );
    }
    if (canonicalStateKey({ ...state, you: snake }) !== target.stateKey) {
      throw new Error(
        `PUCT target state mismatch for turn ${target.turn} snake ${target.snakeId}`,
      );
    }
    if (target.outcome !== outcomeForSnake(target.snakeId, replay.result)) {
      throw new Error(
        `PUCT target outcome mismatch for turn ${target.turn} snake ${target.snakeId}`,
      );
    }
  }
}
