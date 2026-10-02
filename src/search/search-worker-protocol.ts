import type { Direction, GameState } from "../api/types.js";
import type { EvaluationWeights } from "../evaluation/weights.js";
import type { MctsOptions, MctsResult } from "./mcts.js";

export interface SearchWorkerSearchMessage {
  type: "search";
  requestId: number;
  state: GameState;
  fallbackMove: Direction;
  weights: EvaluationWeights;
  options: MctsOptions;
  /** Wall-clock deadline shared by the parent and every worker thread. */
  deadlineEpochMs: number;
  /** Shared cooperative-cancellation flag set by the parent after collection. */
  cancellationBuffer: SharedArrayBuffer;
}

export interface SearchWorkerClearGameMessage {
  type: "clear-game";
  gameId: string;
}

export interface SearchWorkerClearAllMessage {
  type: "clear-all";
}

export type SearchWorkerRequest =
  | SearchWorkerSearchMessage
  | SearchWorkerClearGameMessage
  | SearchWorkerClearAllMessage;

export interface SearchWorkerReadyMessage {
  type: "ready";
}

export interface SearchWorkerResultMessage {
  type: "result";
  requestId: number;
  result: MctsResult;
}

export interface SearchWorkerErrorMessage {
  type: "error";
  requestId: number;
  error: string;
}

export type SearchWorkerResponse =
  | SearchWorkerReadyMessage
  | SearchWorkerResultMessage
  | SearchWorkerErrorMessage;

/**
 * Bounds a queued worker's budget by both the original allocation and the
 * request's shared wall-clock deadline. A stale message therefore receives no
 * new compute budget merely because its worker became available late.
 */
export function remainingSearchBudgetMs(
  deadlineEpochMs: number,
  maximumBudgetMs: number,
  nowEpochMs = Date.now(),
): number {
  if (
    !Number.isFinite(deadlineEpochMs) ||
    !Number.isFinite(maximumBudgetMs) ||
    !Number.isFinite(nowEpochMs) ||
    maximumBudgetMs <= 0
  ) {
    return 0;
  }
  return Math.max(
    0,
    Math.min(maximumBudgetMs, deadlineEpochMs - nowEpochMs),
  );
}
