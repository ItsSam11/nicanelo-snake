import type {
  Battlesnake,
  Coordinate,
  Direction,
  GameState,
} from "../api/types.js";
import {
  DIRECTIONS,
  coordinateKey,
  dangerousHeadToHeadCells,
  guaranteedOccupiedCells,
  isInsideBoard,
  manhattanDistance,
  moveCoordinate,
} from "../domain/board.js";
import type { SnakeMoves } from "../domain/legal-moves.js";
import { simulateTurn } from "../domain/simulate-turn.js";
import { healthAfterMove, projectOurMove } from "./spatial-analysis.js";

const MAX_MULTIPLAYER_MOVES_PER_OPPONENT = 2;
const MAX_REPLY_SCENARIOS = 16;

export interface EscapeResilienceAnalysis {
  currentSafeMoves: number;
  /** Minimum next-turn exits for the best reply-weighted candidate move. */
  bestNextSafeMoves: number;
  replyScenarios: number;
  score: number;
}

function perspectiveState(
  state: Readonly<GameState>,
  snake: Readonly<Battlesnake>,
): GameState {
  return snake.id === state.you.id
    ? state as GameState
    : { ...state, you: snake as Battlesnake };
}

function healthAfterSnakeMove(
  state: Readonly<GameState>,
  snake: Readonly<Battlesnake>,
  destination: Readonly<Coordinate>,
): number {
  const destinationKey = coordinateKey(destination);
  if (state.board.food.some((food) => coordinateKey(food) === destinationKey)) {
    return 100;
  }
  const hazardDamage = state.board.hazards.some(
      (hazard) => coordinateKey(hazard) === destinationKey,
    )
    ? state.game.ruleset.settings.hazardDamagePerTurn
    : 0;
  return snake.health - 1 - hazardDamage;
}

function physicalMovesForSnake(
  state: Readonly<GameState>,
  snake: Readonly<Battlesnake>,
): Direction[] {
  const occupied = guaranteedOccupiedCells(state as GameState);
  const viable = DIRECTIONS.filter((direction) => {
    const destination = moveCoordinate(snake.head, direction);
    return isInsideBoard(
      destination,
      state.board.width,
      state.board.height,
    ) &&
      !occupied.has(coordinateKey(destination)) &&
      healthAfterSnakeMove(state, snake, destination) > 0;
  });

  // The protocol still requires a direction when every move loses. Keeping
  // those replies lets exact simulation decide whether a simultaneous crash
  // can also remove or block us.
  return viable.length > 0 ? viable : [...DIRECTIONS];
}

function safeMoves(state: GameState): Direction[] {
  const occupied = guaranteedOccupiedCells(state);
  const headThreats = dangerousHeadToHeadCells(state);
  return DIRECTIONS.filter((direction) => {
    const destination = moveCoordinate(state.you.head, direction);
    return isInsideBoard(
      destination,
      state.board.width,
      state.board.height,
    ) &&
      !occupied.has(coordinateKey(destination)) &&
      !headThreats.has(coordinateKey(destination)) &&
      healthAfterMove(state, destination) > 0;
  });
}

function blockingOpponentMoves(
  state: Readonly<GameState>,
  opponent: Readonly<Battlesnake>,
  ourDestination: Readonly<Coordinate>,
  maximum: number,
): Direction[] {
  const exits = DIRECTIONS
    .map((direction) => moveCoordinate(ourDestination, direction))
    .filter((candidate) =>
      isInsideBoard(candidate, state.board.width, state.board.height)
    );

  return physicalMovesForSnake(state, opponent)
    .sort((a, b) => {
      const aDestination = moveCoordinate(opponent.head, a);
      const bDestination = moveCoordinate(opponent.head, b);
      const aExitDistance = Math.min(
        ...exits.map((exit) => manhattanDistance(aDestination, exit)),
      );
      const bExitDistance = Math.min(
        ...exits.map((exit) => manhattanDistance(bDestination, exit)),
      );
      return Number(manhattanDistance(bDestination, ourDestination) === 0) -
          Number(manhattanDistance(aDestination, ourDestination) === 0) ||
        aExitDistance - bExitDistance ||
        manhattanDistance(aDestination, ourDestination) -
          manhattanDistance(bDestination, ourDestination) ||
        DIRECTIONS.indexOf(a) - DIRECTIONS.indexOf(b);
    })
    .slice(0, maximum);
}

function jointReplyScenarios(
  state: Readonly<GameState>,
  perspectiveId: string,
  ourMove: Direction,
): SnakeMoves[] {
  const opponents = state.board.snakes.filter(
    (snake) => snake.id !== perspectiveId,
  );
  const ourDestination = moveCoordinate(state.you.head, ourMove);
  const perOpponentLimit = opponents.length === 1
    ? DIRECTIONS.length
    : MAX_MULTIPLAYER_MOVES_PER_OPPONENT;
  let scenarios: SnakeMoves[] = [{ [perspectiveId]: ourMove }];

  for (const opponent of opponents) {
    const moves = blockingOpponentMoves(
      state,
      opponent,
      ourDestination,
      perOpponentLimit,
    );
    const expanded: SnakeMoves[] = [];
    for (const scenario of scenarios) {
      for (const move of moves) {
        expanded.push({ ...scenario, [opponent.id]: move });
        if (expanded.length >= MAX_REPLY_SCENARIOS) break;
      }
      if (expanded.length >= MAX_REPLY_SCENARIOS) break;
    }
    scenarios = expanded;
  }

  return scenarios;
}

function replyWeightedScore(
  scenarios: number,
  zeroExitReplies: number,
  oneExitReplies: number,
): number {
  if (scenarios <= 0) return -1;
  // Keep catastrophic consensus at -1, but do not treat one rare blocker as
  // though every rival reply forces it. MCTS separately samples the reply
  // distribution and applies downside/forced-loss risk at the action level.
  return Math.max(
    -1,
    Math.min(
      1,
      1 - 2 * zeroExitReplies / scenarios -
        0.75 * oneExitReplies / scenarios,
    ),
  );
}

function robustNextSafeMoves(
  state: GameState,
  perspectiveId: string,
  move: Direction,
): {
  moves: number;
  scenarios: number;
  zeroExitReplies: number;
  oneExitReplies: number;
} {
  if (state.game.ruleset.name !== "standard") {
    const projected = projectOurMove(state, move).state;
    const moves = safeMoves(projected).length;
    return {
      moves,
      scenarios: 1,
      zeroExitReplies: Number(moves === 0),
      oneExitReplies: Number(moves === 1),
    };
  }

  const scenarios = jointReplyScenarios(state, perspectiveId, move);
  let minimum = Number.POSITIVE_INFINITY;
  let zeroExitReplies = 0;
  let oneExitReplies = 0;
  for (const moves of scenarios) {
    const next = simulateTurn(state, moves).state;
    const alive = next.board.snakes.some((snake) => snake.id === perspectiveId);
    const exits = alive ? safeMoves(next).length : 0;
    minimum = Math.min(minimum, exits);
    zeroExitReplies += Number(exits === 0);
    oneExitReplies += Number(exits === 1);
  }
  return {
    moves: Number.isFinite(minimum) ? minimum : 0,
    scenarios: scenarios.length,
    zeroExitReplies,
    oneExitReplies,
  };
}

/**
 * Measures whether a state or candidate move retains an escape after plausible
 * simultaneous rival replies. Duels enumerate every rival direction. With two
 * or three rivals, each is limited to its two most relevant blocking moves so
 * the feature remains cheap enough for MCTS leaves. The score grades how many
 * enumerated replies leave zero, one, or multiple exits, avoiding a hard cliff
 * from a single rare blocker while preserving -1 for unanimous catastrophe.
 */
export function analyzeEscapeResilience(
  state: GameState,
  perspectiveId = state.you.id,
  forcedMove?: Direction,
): EscapeResilienceAnalysis {
  const snake = state.board.snakes.find((item) => item.id === perspectiveId);
  if (snake === undefined) {
    return {
      currentSafeMoves: 0,
      bestNextSafeMoves: 0,
      replyScenarios: 0,
      score: -1,
    };
  }
  const perspective = perspectiveState(state, snake);
  const current = safeMoves(perspective);
  const candidates = forcedMove === undefined ? current : [forcedMove];
  if (candidates.length === 0) {
    return {
      currentSafeMoves: current.length,
      bestNextSafeMoves: 0,
      replyScenarios: 0,
      score: -1,
    };
  }

  let bestNextSafeMoves = 0;
  let replyScenarios = 0;
  let bestScore = -1;
  for (const move of candidates) {
    const robust = robustNextSafeMoves(perspective, perspectiveId, move);
    const score = replyWeightedScore(
      robust.scenarios,
      robust.zeroExitReplies,
      robust.oneExitReplies,
    );
    if (score > bestScore ||
      score === bestScore && robust.moves > bestNextSafeMoves) {
      bestScore = score;
      bestNextSafeMoves = robust.moves;
      replyScenarios = robust.scenarios;
    } else if (score === bestScore && robust.moves === bestNextSafeMoves) {
      replyScenarios = Math.max(replyScenarios, robust.scenarios);
    }
  }

  return {
    currentSafeMoves: current.length,
    bestNextSafeMoves,
    replyScenarios,
    score: bestScore,
  };
}
