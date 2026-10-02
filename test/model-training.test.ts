import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STRATEGY_FEATURE_SET_VERSION } from "../src/model/feature-set.js";
import {
  DEFAULT_EVALUATION_WEIGHTS,
  unsafeLearnedEvaluationWeights,
} from "../src/evaluation/weights.js";
import type {
  Battlesnake,
  Direction,
  GameState,
} from "../src/api/types.js";
import { DEFAULT_OPPONENT_POLICY, opponentMoveDistribution } from "../src/search/opponent-policy.js";
import { canonicalStateKey } from "../src/search/state-key.js";
import {
  modelOfflineGate,
  trainStrategyModel,
} from "../src/training/model-training.js";
import {
  buildReplayCorpus,
  type OfficialReplay,
} from "../src/training/replay-corpus.js";
import {
  PUCT_POLICY_TARGET_VERSION,
  type PuctPolicyTarget,
} from "../src/training/search-targets.js";
import { gameState, opponent } from "./fixtures.js";

function moved(snake: Battlesnake, move: Direction): Battlesnake {
  const offsets = {
    up: { x: 0, y: 1 },
    down: { x: 0, y: -1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  } as const;
  const offset = offsets[move];
  const head = { x: snake.head.x + offset.x, y: snake.head.y + offset.y };
  const body = [head, ...snake.body.slice(0, -1)];
  return { ...snake, head, body, length: body.length, latency: "1" };
}

function stateWithSnakes(
  state: GameState,
  turn: number,
  snakes: Battlesnake[],
): GameState {
  return {
    ...state,
    turn,
    board: { ...state.board, snakes },
    you: snakes.find((snake) => snake.id === "us") ?? snakes[0] ?? state.you,
  };
}

function replay(gameId: string, winnerId: string): OfficialReplay {
  const initialBase = gameState({
    youBody: [{ x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 0 }],
    opponents: [
      opponent("a", [{ x: 9, y: 9 }, { x: 9, y: 10 }, { x: 10, y: 10 }]),
      opponent("b", [{ x: 1, y: 9 }, { x: 1, y: 10 }, { x: 0, y: 10 }]),
      opponent("c", [{ x: 9, y: 1 }, { x: 9, y: 0 }, { x: 10, y: 0 }]),
    ],
  });
  const metadata = { ...initialBase.game, id: gameId };
  const initial = { ...initialBase, game: metadata };
  const turnOneSnakes = [
    moved(initial.board.snakes[0]!, "right"),
    moved(initial.board.snakes[1]!, "left"),
    moved(initial.board.snakes[2]!, "down"),
    moved(initial.board.snakes[3]!, "up"),
  ];
  const turnOne = stateWithSnakes(initial, 11, turnOneSnakes);
  const winningSnake = turnOneSnakes.find((snake) => snake.id === winnerId)!;
  const final = stateWithSnakes(initial, 12, [moved(winningSnake, "up")]);
  return {
    metadata,
    states: [initial, turnOne, final],
    result: { winnerId, winnerName: winnerId, isDraw: false },
  };
}

function searchTarget(source: OfficialReplay): PuctPolicyTarget {
  const state = source.states[0]!;
  const distribution = opponentMoveDistribution(
    state,
    state.you.id,
    DEFAULT_OPPONENT_POLICY,
  );
  const visits = distribution.map((candidate) =>
    candidate.move === "right" ? 9 : 1
  );
  const totalVisits = visits.reduce((sum, value) => sum + value, 0);
  return {
    targetVersion: PUCT_POLICY_TARGET_VERSION,
    telemetryEventId: `event-${source.metadata.id}`,
    recordedAt: "2026-09-17T02:00:00.000Z",
    gameId: source.metadata.id,
    turn: state.turn,
    snakeId: state.you.id,
    snakeName: state.you.name,
    stateKey: canonicalStateKey(state),
    modelVersion: "heuristic-puct-v1",
    selectedMove: "right",
    fallbackMove: "right",
    outcome: source.result.winnerId === state.you.id ? 1 : 0,
    usedSearch: true,
    fallbackProtected: false,
    rootSafetyOverridden: false,
    deadlineReached: false,
    iterations: totalVisits,
    priorVisits: 0,
    reusedTree: false,
    workersRequested: 1,
    workersCompleted: 1,
    totalVisits,
    policyEligible: true,
    exclusionReasons: [],
    actions: distribution.map((candidate, index) => ({
      move: candidate.move,
      visits: visits[index]!,
      probability: visits[index]! / totalVisits,
      meanValue: 0.5,
      outcomeCount: visits[index]!,
      prior: candidate.probability,
    })),
  };
}

function trainingGame(
  source: OfficialReplay,
  samplingWeight: number,
  searchTargets: readonly PuctPolicyTarget[] = [],
) {
  return {
    replay: source,
    summary: buildReplayCorpus(source).summary,
    samplingWeight,
    searchTargets,
  };
}

describe("offline strategy training", () => {
  it("fails the offline gate when predictive weights violate control semantics", () => {
    const baseline = {
      policyNll: 1,
      policyAccuracy: 0.5,
      opponentPolicyNll: 1,
      opponentPolicyAccuracy: 0.5,
      opponentPolicyBrier: 0.5,
      valueBrier: 0.5,
    };
    const candidate = {
      ...baseline,
      opponentPolicyNll: 0.9,
      opponentPolicyBrier: 0.49,
      valueBrier: 0.4,
    };

    assert.equal(modelOfflineGate(baseline, candidate, {
      ...DEFAULT_EVALUATION_WEIGHTS,
      mobility: -1,
    }), false);
  });

  it("rejects a relatively improved value model that is still uncalibrated", () => {
    const baseline = {
      policyNll: 1,
      policyAccuracy: 0.5,
      opponentPolicyNll: 1,
      opponentPolicyAccuracy: 0.5,
      opponentPolicyBrier: 0.5,
      valueBrier: 0.53,
    };
    const uncalibrated = {
      ...baseline,
      opponentPolicyNll: 0.9,
      opponentPolicyBrier: 0.49,
      valueBrier: 0.47,
    };
    const calibrated = {
      ...uncalibrated,
      valueBrier: 0.2,
    };

    assert.equal(
      modelOfflineGate(baseline, uncalibrated, DEFAULT_EVALUATION_WEIGHTS),
      false,
    );
    assert.equal(
      modelOfflineGate(baseline, calibrated, DEFAULT_EVALUATION_WEIGHTS),
      true,
    );
  });

  it("is deterministic and keeps a game-level validation split", () => {
    const replays = [replay("game-a", "us"), replay("game-b", "a")];
    const options = {
      modelVersion: "candidate-test",
      createdAt: "2026-09-16T12:00:00.000Z",
      minimumGames: 2,
      epochs: 8,
    } as const;
    const first = trainStrategyModel(replays, options);
    const second = trainStrategyModel([...replays].reverse(), options);

    assert.deepEqual(second, first);
    assert.equal(first.training.corpusGames, 2);
    assert.equal(
      first.training.featureSetVersion,
      STRATEGY_FEATURE_SET_VERSION,
    );
    assert.ok(first.training.trainingSamples > 0);
    assert.ok(first.training.validationSamples > 0);
    assert.equal(first.training.policyPriorTrainingSamples, 0);
    assert.ok((first.training.opponentPolicyTrainingSamples ?? 0) > 0);
    assert.ok((first.training.valueTrainingSamples ?? 0) > 0);
    assert.match(first.training.corpusDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.ok(Number.isFinite(first.training.candidateValidation?.policyNll));
    assert.ok(Number.isFinite(
      first.training.candidateValidation?.opponentPolicyNll,
    ));
    assert.notDeepEqual(first.policyPrior.weights, first.opponentPolicy.weights);
    assert.deepEqual(
      unsafeLearnedEvaluationWeights(first.evaluationWeights),
      [],
    );
    assert.equal(
      first.evaluationWeights.survival,
      DEFAULT_EVALUATION_WEIGHTS.survival,
    );
    assert.ok(Number.isFinite(first.search.valueBias));
  });

  it("uses per-game samplingWeight in gradients and corpus identity", () => {
    const sources = [
      replay("game-a", "us"),
      replay("game-b", "a"),
      replay("game-c", "us"),
    ];
    const options = {
      modelVersion: "candidate-weight-test",
      createdAt: "2026-09-17T12:00:00.000Z",
      minimumGames: 3,
      epochs: 8,
    } as const;
    const equal = trainStrategyModel(
      sources.map((source) => trainingGame(source, 1)),
      options,
    );
    const weighted = trainStrategyModel(
      sources.map((source, index) =>
        trainingGame(source, index === 0 ? 5 : 1)
      ),
      options,
    );

    assert.notEqual(equal.training.corpusDigest, weighted.training.corpusDigest);
    assert.notDeepEqual(
      equal.opponentPolicy.weights,
      weighted.opponentPolicy.weights,
    );
  });

  it("trains the prior from PUCT visits and opponents from observed moves", () => {
    const sources = [replay("game-a", "us"), replay("game-b", "a")];
    const candidate = trainStrategyModel(
      sources.map((source) =>
        trainingGame(source, 1, [searchTarget(source)])
      ),
      {
        modelVersion: "candidate-puct-target-test",
        createdAt: "2026-09-17T13:00:00.000Z",
        minimumGames: 2,
        epochs: 8,
      },
    );

    assert.equal(candidate.training.policyPriorTrainingSamples, 1);
    assert.equal(candidate.training.policyPriorValidationSamples, 1);
    assert.ok((candidate.training.opponentPolicyTrainingSamples ?? 0) > 1);
    assert.notDeepEqual(
      candidate.policyPrior.weights,
      candidate.opponentPolicy.weights,
    );
  });

  it("refuses an undersized corpus", () => {
    assert.throws(
      () => trainStrategyModel([replay("game-a", "us")], {
        modelVersion: "candidate-test",
        minimumGames: 2,
      }),
      /Need at least 2 complete games/,
    );
  });
});
