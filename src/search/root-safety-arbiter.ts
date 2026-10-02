import type { Direction, GameState } from "../api/types.js";
import { DIRECTIONS } from "../domain/board.js";
import { immediateHeadToHeadOutcome } from "../domain/head-to-head.js";
import type { SnakeMoves } from "../domain/legal-moves.js";
import { simulateTurn } from "../domain/simulate-turn.js";
import {
  evaluateMove,
  type MoveEvaluationResult,
} from "../evaluation/evaluate-state.js";
import type { EvaluationWeights } from "../evaluation/weights.js";
import { physicallyViableMoves } from "../strategy/static-policy.js";

/**
 * Standard games normally have at most three opponents. Enumerating all four
 * protocol directions for each of them therefore costs at most 4^3 replies.
 * Above that bound the arbiter declines to make a structural override rather
 * than mistaking a sampled subset for a proof.
 */
export const MAX_EXACT_ROOT_REPLY_SCENARIOS = 64;
export const ROOT_BRANCHING_RESERVE_MAX_REACHABLE_SPACE = 0.06;
export const ROOT_BRANCHING_RESERVE_MAX_RELATIVE_SPACE = 0.125;
export const ROOT_BRANCHING_RESERVE_MIN_MOBILITY_GAIN = 0.25;

export function rootSafetyArbiterEnabled(override?: boolean): boolean {
  if (override !== undefined) return override;
  const configured = process.env.SEARCH_ROOT_SAFETY_ARBITER;
  if (configured === undefined || configured.length === 0) return true;
  if (configured === "true") return true;
  if (configured === "false") return false;
  throw new Error("SEARCH_ROOT_SAFETY_ARBITER must be true or false");
}

/**
 * Experimental extension for locally trapped states. It is off by default so
 * a build can still reproduce both R7 and the first root-safety challenger.
 */
export function rootBranchingReserveEnabled(override?: boolean): boolean {
  if (override !== undefined) return override;
  const configured = process.env.SEARCH_ROOT_BRANCHING_RESERVE;
  if (configured === undefined || configured.length === 0) return false;
  if (configured === "true") return true;
  if (configured === "false") return false;
  throw new Error("SEARCH_ROOT_BRANCHING_RESERVE must be true or false");
}

export type RootSafetyDecisionReason =
  | "accepted"
  | "avoided-immediate-death"
  | "avoided-immediate-nonwin-exposure"
  | "avoided-zero-exit-exposure"
  | "avoided-mixed-nonwin-exposure"
  | "avoided-low-slack-bottleneck"
  | "all-candidates-exposed"
  | "scenario-limit"
  | "unsupported-ruleset";

export interface RootMoveSafetyAssessment {
  move: Direction;
  physicallyViable: boolean;
  exact: boolean;
  replyScenarios: number;
  zeroContinuationReplies: number;
  immediateNonWinReplies: number;
  zeroNextMoveReplies: number;
  terminalWinReplies: number;
  /**
   * Minimum number of physically viable moves on our following turn across
   * every joint opponent response. Terminal wins do not lower the minimum.
   */
  worstCaseNextMoves?: number;
}

export interface RootSafetyAnalysis {
  applicable: boolean;
  reason?: "scenario-limit" | "unsupported-ruleset";
  assessments: readonly RootMoveSafetyAssessment[];
  /** Moves that satisfy every hard invariant available to this analysis. */
  admissibleMoves: readonly Direction[];
}

export interface RootSafetyDecision {
  proposedMove: Direction;
  move: Direction;
  overridden: boolean;
  reason: RootSafetyDecisionReason;
  proposedWorstCaseNextMoves?: number;
  selectedWorstCaseNextMoves?: number;
  proposedReplyScenarios: number;
  proposedImmediateNonWinReplies: number;
  proposedZeroNextMoveReplies: number;
  proposedTerminalWinReplies: number;
  selectedReplyScenarios: number;
  selectedImmediateNonWinReplies: number;
  selectedZeroNextMoveReplies: number;
  selectedTerminalWinReplies: number;
  branchingReserve?: RootBranchingReserveEvidence;
}

export interface RootBranchingReserveEvidence {
  proposedIntent: string;
  selectedIntent: string;
  proposedEvaluationTotal: number;
  selectedEvaluationTotal: number;
  proposedTrapSafety: number;
  selectedTrapSafety: number;
  proposedReachableSpace: number;
  selectedReachableSpace: number;
  proposedRelativeSpace: number;
  selectedRelativeSpace: number;
  proposedMobility: number;
  selectedMobility: number;
}

export interface RootBranchingReserveContext {
  state: GameState;
  weights: Readonly<EvaluationWeights>;
}

export interface RootSafetyArbitrationOptions {
  /** Omit to retain the original hard-invariant-only arbiter. */
  branchingReserve?: Readonly<RootBranchingReserveContext>;
}

function uniqueDirections(moves: readonly Direction[]): Direction[] {
  return [...new Set(moves)];
}

function branchingReserveAlternative(
  analysis: Readonly<RootSafetyAnalysis>,
  proposedMove: Direction,
  preferredMoves: readonly Direction[],
  context: Readonly<RootBranchingReserveContext>,
): { move: Direction; evidence: RootBranchingReserveEvidence } | undefined {
  if (!analysis.applicable) return undefined;
  const proposed = analysis.assessments.find(
    (assessment) => assessment.move === proposedMove,
  );
  if (
    proposed?.exact !== true ||
    proposed.worstCaseNextMoves !== 1 ||
    immediateHeadToHeadOutcome(context.state, proposedMove) === "winning"
  ) {
    return undefined;
  }

  const proposedEvaluation = evaluateMove(
    context.state,
    proposedMove,
    context.weights,
  );
  const proposedIntent = proposedEvaluation.tacticalIntent;
  if (
    proposedIntent.kind !== "SURVIVE" ||
    proposedIntent.resourceRequired ||
    proposedIntent.capturesFood ||
    proposedEvaluation.features.trapSafety > -1 ||
    proposedEvaluation.features.reachableSpace >
      ROOT_BRANCHING_RESERVE_MAX_REACHABLE_SPACE ||
    proposedEvaluation.features.relativeSpace >
      ROOT_BRANCHING_RESERVE_MAX_RELATIVE_SPACE
  ) {
    return undefined;
  }

  const alternatives: Array<{
    assessment: RootMoveSafetyAssessment;
    evaluation: MoveEvaluationResult;
  }> = [];
  for (const assessment of analysis.assessments) {
    if (
      assessment.move === proposedMove ||
      assessment.exact !== true ||
      !assessment.physicallyViable ||
      (assessment.worstCaseNextMoves ?? 0) < 2 ||
      assessment.terminalWinReplies < proposed.terminalWinReplies
    ) {
      continue;
    }
    const evaluation = evaluateMove(
      context.state,
      assessment.move,
      context.weights,
    );
    if (
      evaluation.total <= proposedEvaluation.total ||
      evaluation.features.mobility <
        proposedEvaluation.features.mobility +
          ROOT_BRANCHING_RESERVE_MIN_MOBILITY_GAIN ||
      evaluation.tacticalIntent.foodProgress < proposedIntent.foodProgress ||
      (evaluation.tacticalIntent.resourceRequired &&
        !evaluation.tacticalIntent.resourceGate)
    ) {
      continue;
    }
    alternatives.push({ assessment, evaluation });
  }

  const byMove = new Map(
    alternatives.map((alternative) => [alternative.assessment.move, alternative]),
  );
  const selected = uniqueDirections(preferredMoves)
    .map((move) => byMove.get(move))
    .find((alternative) => alternative !== undefined) ??
    alternatives.sort((a, b) =>
      b.evaluation.total - a.evaluation.total ||
      (b.assessment.worstCaseNextMoves ?? 0) -
        (a.assessment.worstCaseNextMoves ?? 0) ||
      b.assessment.terminalWinReplies - a.assessment.terminalWinReplies
    )[0];
  if (selected === undefined) return undefined;
  return {
    move: selected.assessment.move,
    evidence: {
      proposedIntent: proposedIntent.kind,
      selectedIntent: selected.evaluation.tacticalIntent.kind,
      proposedEvaluationTotal: proposedEvaluation.total,
      selectedEvaluationTotal: selected.evaluation.total,
      proposedTrapSafety: proposedEvaluation.features.trapSafety,
      selectedTrapSafety: selected.evaluation.features.trapSafety,
      proposedReachableSpace: proposedEvaluation.features.reachableSpace,
      selectedReachableSpace: selected.evaluation.features.reachableSpace,
      proposedRelativeSpace: proposedEvaluation.features.relativeSpace,
      selectedRelativeSpace: selected.evaluation.features.relativeSpace,
      proposedMobility: proposedEvaluation.features.mobility,
      selectedMobility: selected.evaluation.features.mobility,
    },
  };
}

function jointOpponentReplies(
  state: Readonly<GameState>,
  ourMove: Direction,
): SnakeMoves[] | undefined {
  const opponents = state.board.snakes.filter(
    (snake) => snake.id !== state.you.id,
  );
  const scenarioCount = Math.pow(DIRECTIONS.length, opponents.length);
  if (scenarioCount > MAX_EXACT_ROOT_REPLY_SCENARIOS) return undefined;

  let replies: SnakeMoves[] = [{ [state.you.id]: ourMove }];
  for (const opponent of opponents) {
    replies = replies.flatMap((reply) =>
      DIRECTIONS.map((move) => ({ ...reply, [opponent.id]: move }))
    );
  }
  return replies;
}

function perspectiveState(state: GameState): GameState | undefined {
  const snake = state.board.snakes.find((item) => item.id === state.you.id);
  return snake === undefined ? undefined : { ...state, you: snake };
}

function assessMove(
  state: GameState,
  move: Direction,
  physicallyViable: boolean,
): RootMoveSafetyAssessment {
  if (!physicallyViable) {
    return {
      move,
      physicallyViable: false,
      exact: true,
      replyScenarios: 0,
      zeroContinuationReplies: 0,
      immediateNonWinReplies: 0,
      zeroNextMoveReplies: 0,
      terminalWinReplies: 0,
      worstCaseNextMoves: 0,
    };
  }

  const replies = jointOpponentReplies(state, move);
  if (replies === undefined) {
    return {
      move,
      physicallyViable: true,
      exact: false,
      replyScenarios: 0,
      zeroContinuationReplies: 0,
      immediateNonWinReplies: 0,
      zeroNextMoveReplies: 0,
      terminalWinReplies: 0,
    };
  }

  let worstCaseNextMoves = Number.POSITIVE_INFINITY;
  let zeroContinuationReplies = 0;
  let immediateNonWinReplies = 0;
  let zeroNextMoveReplies = 0;
  let terminalWinReplies = 0;
  for (const reply of replies) {
    const result = simulateTurn(state, reply);
    if (
      result.outcome.gameOver &&
      result.outcome.result === "win" &&
      result.outcome.winnerId === state.you.id
    ) {
      terminalWinReplies += 1;
      continue;
    }

    const next = perspectiveState(result.state);
    if (next === undefined) {
      // Missing from the successor means either a loss or mutual-elimination
      // draw. Keep the metric outcome-neutral instead of calling both losses.
      immediateNonWinReplies += 1;
      zeroContinuationReplies += 1;
      worstCaseNextMoves = 0;
      continue;
    }
    const nextMoves = physicallyViableMoves(next).length;
    worstCaseNextMoves = Math.min(worstCaseNextMoves, nextMoves);
    zeroContinuationReplies += Number(nextMoves === 0);
    zeroNextMoveReplies += Number(nextMoves === 0);
  }

  // A move that wins under every possible reply needs no following exit.
  const allRepliesWin = terminalWinReplies === replies.length;
  return {
    move,
    physicallyViable: true,
    exact: true,
    replyScenarios: replies.length,
    zeroContinuationReplies,
    immediateNonWinReplies,
    zeroNextMoveReplies,
    terminalWinReplies,
    worstCaseNextMoves: allRepliesWin
      ? DIRECTIONS.length
      : Number.isFinite(worstCaseNextMoves)
      ? worstCaseNextMoves
      : 0,
  };
}

/**
 * Builds a root-only safety dossier. It does not score food, territory or
 * aggression; those remain the responsibility of the tactical policy and
 * MCTS. The dossier answers only whether a safer continuation is provable.
 */
export function analyzeRootSafety(state: GameState): RootSafetyAnalysis {
  const viableMoves = physicallyViableMoves(state);
  const protocolMoves = viableMoves.length > 0 ? viableMoves : [...DIRECTIONS];

  if (state.game.ruleset.name !== "standard") {
    return {
      applicable: false,
      reason: "unsupported-ruleset",
      assessments: DIRECTIONS.map((move) => ({
        move,
        physicallyViable: viableMoves.includes(move),
        exact: false,
        replyScenarios: 0,
        zeroContinuationReplies: 0,
        immediateNonWinReplies: 0,
        zeroNextMoveReplies: 0,
        terminalWinReplies: 0,
      })),
      admissibleMoves: protocolMoves,
    };
  }

  const viable = new Set(viableMoves);
  const assessments = DIRECTIONS.map((move) =>
    assessMove(state, move, viable.has(move))
  );
  if (assessments.some((item) => !item.exact)) {
    return {
      applicable: false,
      reason: "scenario-limit",
      assessments,
      admissibleMoves: protocolMoves,
    };
  }

  // A direction that survives every joint reply with a physical continuation
  // is strictly safer than one whose adversarial worst case has no next move.
  const robust = assessments.filter(
    (item) =>
      item.physicallyViable && (item.worstCaseNextMoves ?? 0) > 0,
  );
  return {
    applicable: true,
    assessments,
    admissibleMoves: robust.length > 0
      ? robust.map((item) => item.move)
      : protocolMoves,
  };
}

/**
 * Applies the hard safety dossier to an already proposed root action. The
 * caller supplies preferences ordered by the existing tactical/MCTS policy;
 * the arbiter changes policy only when the proposal violates an avoidable
 * invariant.
 */
export function arbitrateRootMove(
  analysis: Readonly<RootSafetyAnalysis>,
  proposedMove: Direction,
  preferredMoves: readonly Direction[],
  options: Readonly<RootSafetyArbitrationOptions> = {},
): RootSafetyDecision {
  const assessments = new Map(
    analysis.assessments.map((item) => [item.move, item]),
  );
  const proposed = assessments.get(proposedMove);
  const admissible = new Set(analysis.admissibleMoves);
  const hardSelected = admissible.has(proposedMove)
    ? proposedMove
    : uniqueDirections([...preferredMoves, ...admissible])
      .find((move) => admissible.has(move)) ?? proposedMove;
  const branchingSelected = hardSelected === proposedMove &&
      options.branchingReserve !== undefined
    ? branchingReserveAlternative(
      analysis,
      proposedMove,
      preferredMoves,
      options.branchingReserve,
    )
    : undefined;
  const selected = branchingSelected?.move ?? hardSelected;
  const selectedAssessment = assessments.get(selected);
  const overridden = selected !== proposedMove;

  let reason: RootSafetyDecisionReason;
  if (!analysis.applicable) {
    reason = analysis.reason ?? "scenario-limit";
  } else if (branchingSelected !== undefined) {
    reason = "avoided-low-slack-bottleneck";
  } else if (overridden && proposed?.physicallyViable === false) {
    reason = "avoided-immediate-death";
  } else if (overridden) {
    const hasImmediateNonWin =
      (proposed?.immediateNonWinReplies ?? 0) > 0;
    const hasZeroExit = (proposed?.zeroNextMoveReplies ?? 0) > 0;
    reason = hasImmediateNonWin && hasZeroExit
      ? "avoided-mixed-nonwin-exposure"
      : hasImmediateNonWin
      ? "avoided-immediate-nonwin-exposure"
      : "avoided-zero-exit-exposure";
  } else if ((proposed?.worstCaseNextMoves ?? 0) === 0) {
    reason = "all-candidates-exposed";
  } else {
    reason = "accepted";
  }

  return {
    proposedMove,
    move: analysis.applicable ? selected : proposedMove,
    overridden: analysis.applicable && overridden,
    reason,
    ...(proposed?.worstCaseNextMoves === undefined
      ? {}
      : { proposedWorstCaseNextMoves: proposed.worstCaseNextMoves }),
    ...(selectedAssessment?.worstCaseNextMoves === undefined
      ? {}
      : { selectedWorstCaseNextMoves: selectedAssessment.worstCaseNextMoves }),
    proposedReplyScenarios: proposed?.replyScenarios ?? 0,
    proposedImmediateNonWinReplies: proposed?.immediateNonWinReplies ?? 0,
    proposedZeroNextMoveReplies: proposed?.zeroNextMoveReplies ?? 0,
    proposedTerminalWinReplies: proposed?.terminalWinReplies ?? 0,
    selectedReplyScenarios: selectedAssessment?.replyScenarios ?? 0,
    selectedImmediateNonWinReplies:
      selectedAssessment?.immediateNonWinReplies ?? 0,
    selectedZeroNextMoveReplies: selectedAssessment?.zeroNextMoveReplies ?? 0,
    selectedTerminalWinReplies: selectedAssessment?.terminalWinReplies ?? 0,
    ...(branchingSelected === undefined
      ? {}
      : { branchingReserve: branchingSelected.evidence }),
  };
}
