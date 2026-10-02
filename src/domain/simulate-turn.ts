import type {
  Battlesnake,
  Coordinate,
  GameState,
  RulesetSettings,
} from "../api/types.js";
import { coordinateKey, moveCoordinate } from "./board.js";
import {
  findCollisionEliminations,
  findNonCollisionEliminations,
  type SnakeElimination,
} from "./collisions.js";
import { getGameOutcome, type GameOutcome } from "./game-over.js";
import { validateMoves, type SnakeMoves } from "./legal-moves.js";

const MAX_HEALTH = 100;

export interface SimulationResult {
  state: GameState;
  eliminations: readonly SnakeElimination[];
  outcome: GameOutcome;
}

function cloneCoordinate(coordinate: Coordinate): Coordinate {
  return { x: coordinate.x, y: coordinate.y };
}

function cloneSnake(snake: Battlesnake): Battlesnake {
  return {
    ...snake,
    body: snake.body.map(cloneCoordinate),
    head: cloneCoordinate(snake.head),
    ...(snake.customizations === undefined
      ? {}
      : { customizations: { ...snake.customizations } }),
  };
}

function cloneSettings(settings: RulesetSettings): RulesetSettings {
  return {
    ...settings,
    ...(settings.royale === undefined
      ? {}
      : { royale: { ...settings.royale } }),
  };
}

function cloneState(state: GameState): GameState {
  return {
    game: {
      ...state.game,
      ruleset: {
        ...state.game.ruleset,
        settings: cloneSettings(state.game.ruleset.settings),
      },
    },
    turn: state.turn,
    board: {
      ...state.board,
      food: state.board.food.map(cloneCoordinate),
      hazards: state.board.hazards.map(cloneCoordinate),
      snakes: state.board.snakes.map(cloneSnake),
    },
    you: cloneSnake(state.you),
  };
}

function moveSnake(snake: Battlesnake, moves: SnakeMoves): Battlesnake {
  const direction = moves[snake.id];
  if (direction === undefined) {
    throw new Error(`Missing move for snake ${snake.id}`);
  }

  const newHead = moveCoordinate(snake.head, direction);
  const body = [
    newHead,
    ...snake.body.slice(0, -1).map(cloneCoordinate),
  ];

  return {
    ...cloneSnake(snake),
    health: snake.health - 1,
    body,
    head: cloneCoordinate(newHead),
    length: body.length,
  };
}

function applyHazardDamage(
  snake: Battlesnake,
  hazardKeys: ReadonlySet<string>,
  foodKeys: ReadonlySet<string>,
  damage: number,
): { snake: Battlesnake; elimination?: SnakeElimination } {
  const headKey = coordinateKey(snake.head);
  if (!hazardKeys.has(headKey) || foodKeys.has(headKey)) {
    return { snake };
  }

  const health = Math.max(0, Math.min(MAX_HEALTH, snake.health - damage));
  const damaged = { ...snake, health };

  return health <= 0
    ? {
        snake: damaged,
        elimination: { snakeId: snake.id, cause: "hazard" },
      }
    : { snake: damaged };
}

function feedSnake(snake: Battlesnake): Battlesnake {
  const tail = snake.body.at(-1);
  if (tail === undefined) {
    throw new Error(`Snake ${snake.id} has an empty body`);
  }

  const body = [...snake.body, cloneCoordinate(tail)];
  return { ...snake, body, health: MAX_HEALTH, length: body.length };
}

/**
 * Simulates the deterministic portion of one multiplayer Standard-rules turn.
 * Random food spawning and map-specific mutations are intentionally excluded:
 * they cannot be reproduced from a Battlesnake API payload alone.
 */
export function simulateTurn(
  state: GameState,
  moves: SnakeMoves,
): SimulationResult {
  if (state.game.ruleset.name !== "standard") {
    throw new Error(
      `Unsupported ruleset for exact simulation: ${state.game.ruleset.name}`,
    );
  }

  const initialOutcome = getGameOutcome(state);
  if (initialOutcome.gameOver) {
    const copiedState = cloneState(state);
    return {
      state: copiedState,
      eliminations: [],
      outcome: getGameOutcome(copiedState),
    };
  }

  validateMoves(state, moves);

  const moved = state.board.snakes.map((snake) => moveSnake(snake, moves));
  const hazardKeys = new Set(state.board.hazards.map(coordinateKey));
  const foodKeys = new Set(state.board.food.map(coordinateKey));
  const hazardEliminations: SnakeElimination[] = [];
  const afterHazards = moved.map((snake) => {
    const result = applyHazardDamage(
      snake,
      hazardKeys,
      foodKeys,
      state.game.ruleset.settings.hazardDamagePerTurn,
    );
    if (result.elimination !== undefined) {
      hazardEliminations.push(result.elimination);
    }
    return result.snake;
  });
  const hazardDeaths = new Set(
    hazardEliminations.map((item) => item.snakeId),
  );

  const eatenFood = new Set<string>();
  const afterFeeding = afterHazards.map((snake) => {
    const headKey = coordinateKey(snake.head);
    if (hazardDeaths.has(snake.id) || !foodKeys.has(headKey)) {
      return snake;
    }
    eatenFood.add(headKey);
    return feedSnake(snake);
  });

  const remainingFood = state.board.food
    .filter((food) => !eatenFood.has(coordinateKey(food)))
    .map(cloneCoordinate);
  const eligibleAfterHazards = afterFeeding.filter(
    (snake) => !hazardDeaths.has(snake.id),
  );
  const nonCollisionEliminations = findNonCollisionEliminations(
    eligibleAfterHazards,
    state.board.width,
    state.board.height,
  );
  const nonCollisionDeaths = new Set(
    nonCollisionEliminations.map((item) => item.snakeId),
  );
  const collisionCandidates = eligibleAfterHazards.filter(
    (snake) => !nonCollisionDeaths.has(snake.id),
  );
  const collisionEliminations = findCollisionEliminations(
    collisionCandidates,
  );
  const eliminations = [
    ...hazardEliminations,
    ...nonCollisionEliminations,
    ...collisionEliminations,
  ];
  const eliminatedIds = new Set(eliminations.map((item) => item.snakeId));
  const survivors = afterFeeding.filter(
    (snake) => !eliminatedIds.has(snake.id),
  );
  const nextYou = afterFeeding.find((snake) => snake.id === state.you.id);
  if (nextYou === undefined) {
    throw new Error(`The controlled snake ${state.you.id} is not on the board`);
  }

  const nextState: GameState = {
    game: {
      ...state.game,
      ruleset: {
        ...state.game.ruleset,
        settings: cloneSettings(state.game.ruleset.settings),
      },
    },
    turn: state.turn + 1,
    board: {
      ...state.board,
      food: remainingFood,
      hazards: state.board.hazards.map(cloneCoordinate),
      snakes: survivors,
    },
    you: nextYou,
  };

  return {
    state: nextState,
    eliminations,
    outcome: getGameOutcome(nextState),
  };
}
