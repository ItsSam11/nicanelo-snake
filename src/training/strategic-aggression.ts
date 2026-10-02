import type { Direction, GameState } from "../api/types.js";
import { analyzeSpatialMove, type SpatialMoveAnalysis } from
  "../evaluation/spatial-analysis.js";
import { immediateHeadToHeadOutcome } from "../domain/head-to-head.js";
import { physicallyViableMoves } from "../strategy/static-policy.js";
import type { OfficialReplay } from "./replay-corpus.js";

export const STRATEGIC_AGGRESSION_METRIC_VERSION =
  "post-length-advantage-v1" as const;

const PRESSURE_OPPORTUNITY_SPREAD = 0.08;
const PRESSURE_SELECTION_THRESHOLD = 0.75;
const VULNERABILITY_GAIN_THRESHOLD = 0.25;
const EXIT_REDUCTION_THRESHOLD = 0.25;
const SPACE_REDUCTION_THRESHOLD = 0.2;

export interface StrategicAggressionObservation {
  turn: number;
  snakeId: string;
  move: Direction;
}

export interface StrategicAggressionSummary {
  metricVersion: typeof STRATEGIC_AGGRESSION_METRIC_VERSION;
  snakeId: string;
  snakeName: string;
  advantage: {
    /** Observable moves beginning with a strict lead over at least one rival. */
    observedTurns: number;
    /** Observable moves beginning strictly longer than every living rival. */
    globalLeadTurns: number;
    firstObservedTurn: number | null;
  };
  pressure: {
    /** Turns with two safe choices and a material conversion-intensity spread. */
    opportunityTurns: number;
    /** Chosen intensity >=0.75 of the observed safe-candidate range. */
    selectedTurns: number;
    meanChoiceScore: number | null;
    /** Chosen engine pressure before the length-conversion increment. */
    meanBasePressure: number | null;
    /** Chosen bounded length-conversion signal. */
    meanAdvantageConversion: number | null;
    /** Maximal consecutive selected runs against the same target. */
    sustainedRuns: number;
    longestRun: number;
  };
  traps: {
    /** Turns where a safe move could materially constrain a shorter rival. */
    opportunityTurns: number;
    /** Trap opportunities selecting material projected constraint progress. */
    projectedConstraintSelections: number;
    /** Chosen constraint progress, averaged over trap opportunities. */
    meanChosenProgress: number | null;
  };
  favorableHeadToHead: {
    /** Turns where a safe move offered a strictly winning possible contest. */
    opportunityTurns: number;
    /** Opportunity turns where the observed move offered that contest. */
    offers: number;
  };
  eliminations: {
    /** Shorter rivals absent on the next frame while this snake survived. */
    opponentEliminationsWhileLeading: number;
    /** Same event while this snake led every living rival. */
    opponentEliminationsWhileGloballyLeading: number;
    /** Selected constrained targets absent on the next frame; not kill credit. */
    associatedEliminations: number;
  };
}

interface CandidateAnalysis {
  move: Direction;
  analysis: SpatialMoveAnalysis;
  targetId?: string;
  preMoveStrictControl: boolean;
  safe: boolean;
  pressureIntensity: number;
  basePressure: number;
  meaningfulConstraint: boolean;
  constraintProgress: number;
  favorableHeadToHead: boolean;
}

interface MutableSummary {
  value: StrategicAggressionSummary;
  choiceScoreSum: number;
  basePressureSum: number;
  advantageConversionSum: number;
  constraintProgressSum: number;
  currentRunTarget?: string;
  currentRunLastTurn?: number;
  currentRunLength: number;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function mean(sum: number, count: number): number | null {
  return count === 0 ? null : rounded(sum / count);
}

function emptySummary(snakeId: string, snakeName: string): MutableSummary {
  return {
    value: {
      metricVersion: STRATEGIC_AGGRESSION_METRIC_VERSION,
      snakeId,
      snakeName,
      advantage: {
        observedTurns: 0,
        globalLeadTurns: 0,
        firstObservedTurn: null,
      },
      pressure: {
        opportunityTurns: 0,
        selectedTurns: 0,
        meanChoiceScore: null,
        meanBasePressure: null,
        meanAdvantageConversion: null,
        sustainedRuns: 0,
        longestRun: 0,
      },
      traps: {
        opportunityTurns: 0,
        projectedConstraintSelections: 0,
        meanChosenProgress: null,
      },
      favorableHeadToHead: {
        opportunityTurns: 0,
        offers: 0,
      },
      eliminations: {
        opponentEliminationsWhileLeading: 0,
        opponentEliminationsWhileGloballyLeading: 0,
        associatedEliminations: 0,
      },
    },
    choiceScoreSum: 0,
    basePressureSum: 0,
    advantageConversionSum: 0,
    constraintProgressSum: 0,
    currentRunLength: 0,
  };
}

function perspectiveState(state: Readonly<GameState>, snakeId: string): GameState {
  const snake = state.board.snakes.find((item) => item.id === snakeId);
  if (snake === undefined) {
    throw new Error(`Cannot analyze aggression for missing snake ${snakeId}`);
  }
  return { ...state, you: snake };
}

function materialConstraint(candidate: Readonly<SpatialMoveAnalysis>): boolean {
  const targetId = candidate.offense.targetId;
  const target = targetId === undefined
    ? undefined
    : candidate.offense.rivals.find((rival) => rival.opponentId === targetId);
  return target !== undefined && (
    target.vulnerabilityGain >= VULNERABILITY_GAIN_THRESHOLD ||
    target.exitReduction >= EXIT_REDUCTION_THRESHOLD ||
    target.spaceReduction >= SPACE_REDUCTION_THRESHOLD
  );
}

function candidateAnalyses(state: GameState): CandidateAnalysis[] {
  return physicallyViableMoves(state).map((move) => {
    const analysis = analyzeSpatialMove(state, move);
    const targetId = analysis.offense.targetId;
    const target = targetId === undefined
      ? undefined
      : state.board.snakes.find((snake) => snake.id === targetId);
    // "Post advantage" is intentionally based on the pre-move state. Eating on
    // this move creates control for the next state; it does not retroactively
    // turn an equal contest into a favorable one.
    const preMoveStrictControl = target !== undefined &&
      state.you.length > target.length;
    const safe = analysis.projectedHealth > 0 &&
      analysis.trap.hasEnoughSpace &&
      analysis.trap.openExits > 0 &&
      analysis.offense.postAttackSafety > 0 &&
      immediateHeadToHeadOutcome(state, move) !== "losing";
    const controlledAndSafe = preMoveStrictControl &&
      analysis.offense.strictLengthControl && safe;
    return {
      move,
      analysis,
      ...(targetId === undefined ? {} : { targetId }),
      preMoveStrictControl,
      safe,
      pressureIntensity: controlledAndSafe
        ? analysis.offense.advantageConversion
        : 0,
      basePressure: controlledAndSafe ? analysis.offense.basePressure : 0,
      meaningfulConstraint: controlledAndSafe && materialConstraint(analysis),
      constraintProgress: controlledAndSafe
        ? analysis.offense.constraintProgress
        : 0,
      favorableHeadToHead: safe &&
        immediateHeadToHeadOutcome(state, move) === "winning",
    };
  });
}

function finishRun(summary: MutableSummary): void {
  if (summary.currentRunLength >= 2) {
    summary.value.pressure.sustainedRuns += 1;
    summary.value.pressure.longestRun = Math.max(
      summary.value.pressure.longestRun,
      summary.currentRunLength,
    );
  }
  delete summary.currentRunTarget;
  delete summary.currentRunLastTurn;
  summary.currentRunLength = 0;
}

function continueRun(
  summary: MutableSummary,
  turn: number,
  targetId: string | undefined,
): void {
  if (targetId === undefined) {
    finishRun(summary);
    return;
  }
  if (
    summary.currentRunTarget === targetId &&
    summary.currentRunLastTurn !== undefined &&
    turn === summary.currentRunLastTurn + 1
  ) {
    summary.currentRunLength += 1;
    summary.currentRunLastTurn = turn;
    return;
  }
  finishRun(summary);
  summary.currentRunTarget = targetId;
  summary.currentRunLastTurn = turn;
  summary.currentRunLength = 1;
}

/**
 * Measures how observed moves use an already-held strict length advantage.
 *
 * Only consecutive replay transitions with an inferable surviving move enter
 * the analysis. Elimination counts are temporal associations, never causal kill
 * attribution: official replays omit the eliminated snake's final move.
 */
export function analyzeStrategicAggression(
  replay: Readonly<OfficialReplay>,
  observations: readonly StrategicAggressionObservation[],
): StrategicAggressionSummary[] {
  const initial = replay.states[0];
  if (initial === undefined) return [];
  const states = new Map(replay.states.map((state) => [state.turn, state]));
  const summaries = new Map(
    initial.board.snakes.map((snake) => [
      snake.id,
      emptySummary(snake.id, snake.name),
    ]),
  );
  const ordered = [...observations].sort(
    (a, b) => a.turn - b.turn || a.snakeId.localeCompare(b.snakeId),
  );

  for (const observation of ordered) {
    const before = states.get(observation.turn);
    const after = states.get(observation.turn + 1);
    const summary = summaries.get(observation.snakeId);
    if (before === undefined || after === undefined || summary === undefined) {
      continue;
    }
    // A missing frame makes both action effects and elimination association
    // unknowable. Never bridge that gap.
    if (after.turn !== before.turn + 1) continue;
    const state = perspectiveState(before, observation.snakeId);
    const snakeAfter = after.board.snakes.find(
      (snake) => snake.id === observation.snakeId,
    );
    if (snakeAfter === undefined) continue;
    const opponents = state.board.snakes.filter(
      (snake) => snake.id !== observation.snakeId,
    );
    const shorter = opponents.filter(
      (opponent) => state.you.length > opponent.length,
    );
    if (shorter.length === 0) {
      finishRun(summary);
      continue;
    }

    summary.value.advantage.observedTurns += 1;
    summary.value.advantage.firstObservedTurn ??= observation.turn;
    const globalLead = shorter.length === opponents.length;
    if (globalLead) summary.value.advantage.globalLeadTurns += 1;

    const candidates = candidateAnalyses(state);
    const chosen = candidates.find((candidate) =>
      candidate.move === observation.move
    );
    const safeCandidates = candidates.filter((candidate) => candidate.safe);
    const pressureValues = safeCandidates.map((candidate) =>
      candidate.pressureIntensity
    );
    const minimumPressure = pressureValues.length === 0
      ? 0
      : Math.min(...pressureValues);
    const maximumPressure = pressureValues.length === 0
      ? 0
      : Math.max(...pressureValues);
    const pressureSpread = maximumPressure - minimumPressure;
    const pressureOpportunity = chosen !== undefined &&
      safeCandidates.length >= 2 &&
      maximumPressure > 0 &&
      pressureSpread >= PRESSURE_OPPORTUNITY_SPREAD;
    let pressureSelected = false;
    if (pressureOpportunity) {
      const choiceScore = Math.max(
        0,
        Math.min(
          1,
          (chosen.pressureIntensity - minimumPressure) / pressureSpread,
        ),
      );
      pressureSelected = choiceScore >= PRESSURE_SELECTION_THRESHOLD;
      summary.value.pressure.opportunityTurns += 1;
      summary.choiceScoreSum += choiceScore;
      summary.basePressureSum += chosen.basePressure;
      summary.advantageConversionSum += chosen.pressureIntensity;
      if (pressureSelected) summary.value.pressure.selectedTurns += 1;
    }
    if (pressureSelected) {
      continueRun(summary, observation.turn, chosen?.targetId);
    } else {
      finishRun(summary);
    }

    const trapOpportunity = candidates.some((candidate) =>
      candidate.meaningfulConstraint
    );
    const chosenConstraint = chosen?.constraintProgress ?? 0;
    const selectedProjectedConstraint = chosen?.meaningfulConstraint === true;
    if (trapOpportunity) {
      summary.value.traps.opportunityTurns += 1;
      summary.constraintProgressSum += chosenConstraint;
      if (selectedProjectedConstraint) {
        summary.value.traps.projectedConstraintSelections += 1;
      }
    }

    const favorableOpportunity = candidates.some((candidate) =>
      candidate.favorableHeadToHead
    );
    if (favorableOpportunity) {
      summary.value.favorableHeadToHead.opportunityTurns += 1;
      if (chosen?.favorableHeadToHead === true) {
        summary.value.favorableHeadToHead.offers += 1;
      }
    }

    const survivingIds = new Set(after.board.snakes.map((snake) => snake.id));
    const eliminatedWhileLeading = shorter.filter((opponent) =>
      !survivingIds.has(opponent.id)
    );
    summary.value.eliminations.opponentEliminationsWhileLeading +=
      eliminatedWhileLeading.length;
    if (globalLead) {
      summary.value.eliminations.opponentEliminationsWhileGloballyLeading +=
        eliminatedWhileLeading.length;
    }
    if (
      selectedProjectedConstraint && chosen?.targetId !== undefined &&
      !survivingIds.has(chosen.targetId)
    ) {
      summary.value.eliminations.associatedEliminations += 1;
    }
  }

  return [...summaries.values()].map((summary) => {
    finishRun(summary);
    const pressureCount = summary.value.pressure.opportunityTurns;
    const trapCount = summary.value.traps.opportunityTurns;
    return {
      ...summary.value,
      pressure: {
        ...summary.value.pressure,
        meanChoiceScore: mean(summary.choiceScoreSum, pressureCount),
        meanBasePressure: mean(summary.basePressureSum, pressureCount),
        meanAdvantageConversion: mean(
          summary.advantageConversionSum,
          pressureCount,
        ),
      },
      traps: {
        ...summary.value.traps,
        meanChosenProgress: mean(summary.constraintProgressSum, trapCount),
      },
    };
  });
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function unitOrNull(value: unknown): boolean {
  return value === null || (
    typeof value === "number" && Number.isFinite(value) &&
    value >= 0 && value <= 1
  );
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Accepts historical summaries where the optional metric block is absent. */
export function validStrategicAggressionSummaries(
  value: unknown,
): value is StrategicAggressionSummary[] {
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    const summary = object(item);
    const advantage = object(summary?.advantage);
    const pressure = object(summary?.pressure);
    const traps = object(summary?.traps);
    const headToHead = object(summary?.favorableHeadToHead);
    const eliminations = object(summary?.eliminations);
    if (
      summary?.metricVersion !== STRATEGIC_AGGRESSION_METRIC_VERSION ||
      typeof summary.snakeId !== "string" || summary.snakeId.length === 0 ||
      typeof summary.snakeName !== "string" ||
      advantage === undefined || pressure === undefined || traps === undefined ||
      headToHead === undefined || eliminations === undefined
    ) return false;
    const firstObservedTurn = advantage.firstObservedTurn;
    return [advantage.observedTurns, advantage.globalLeadTurns,
      pressure.opportunityTurns, pressure.selectedTurns,
      pressure.sustainedRuns, pressure.longestRun,
      traps.opportunityTurns, traps.projectedConstraintSelections,
      headToHead.opportunityTurns, headToHead.offers,
      eliminations.opponentEliminationsWhileLeading,
      eliminations.opponentEliminationsWhileGloballyLeading,
      eliminations.associatedEliminations].every(nonNegativeInteger) &&
      (firstObservedTurn === null || nonNegativeInteger(firstObservedTurn)) &&
      [pressure.meanChoiceScore, pressure.meanBasePressure,
        pressure.meanAdvantageConversion,
        traps.meanChosenProgress].every(unitOrNull) &&
      (advantage.globalLeadTurns as number) <=
        (advantage.observedTurns as number) &&
      (pressure.selectedTurns as number) <=
        (pressure.opportunityTurns as number) &&
      (traps.projectedConstraintSelections as number) <=
        (traps.opportunityTurns as number) &&
      (headToHead.offers as number) <=
        (headToHead.opportunityTurns as number);
  });
}
