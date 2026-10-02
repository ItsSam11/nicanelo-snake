import type {
  Battlesnake,
  Coordinate,
  Direction,
  GameState,
} from "../api/types.js";
import {
  guaranteedOccupiedCells,
  moveCoordinate,
  sameCoordinate,
} from "../domain/board.js";
import {
  shortestPathToOwnTail,
  shortestSurvivablePathToFood,
} from "./pathfinding.js";
import {
  analyzeTerritory,
  blendedTerritoryAdvantage,
  territoryCount,
} from "./territory.js";
import { analyzeTraps, type TrapAnalysis } from "./traps.js";
import {
  analyzeOffensiveMove,
  type OffensiveMoveAnalysis,
  type ProjectedOffensiveMove,
} from "./offense.js";

export interface SpatialMoveAnalysis {
  destination: Coordinate;
  projectedHealth: number;
  trap: TrapAnalysis;
  safeFoodDistance?: number;
  safeFoodTarget?: Coordinate;
  tailDistance?: number;
  ownedTerritory: number;
  strongestOpponentTerritory: number;
  territoryAdvantage: number;
  contestedCells: number;
  offense: OffensiveMoveAnalysis;
}

function cloneCoordinate(coordinate: Coordinate): Coordinate {
  return { x: coordinate.x, y: coordinate.y };
}

function cloneSnake(snake: Battlesnake): Battlesnake {
  return {
    ...snake,
    head: cloneCoordinate(snake.head),
    body: snake.body.map(cloneCoordinate),
  };
}

function hasCoordinate(
  coordinates: readonly Coordinate[],
  target: Coordinate,
): boolean {
  return coordinates.some((coordinate) => sameCoordinate(coordinate, target));
}

export function healthAfterMove(
  state: GameState,
  destination: Coordinate,
): number {
  if (hasCoordinate(state.board.food, destination)) {
    return 100;
  }

  const hazardDamage = hasCoordinate(state.board.hazards, destination)
    ? state.game.ruleset.settings.hazardDamagePerTurn
    : 0;
  return Math.max(0, state.you.health - 1 - hazardDamage);
}

export function projectOurMove(
  state: GameState,
  direction: Direction,
): ProjectedOffensiveMove {
  const destination = moveCoordinate(state.you.head, direction);
  const eats = hasCoordinate(state.board.food, destination);
  const movedBody = [
    destination,
    ...state.you.body.slice(0, -1).map(cloneCoordinate),
  ];
  const growthSegment = movedBody.at(-1);
  const body = eats && growthSegment !== undefined
    ? [...movedBody, cloneCoordinate(growthSegment)]
    : movedBody;

  const projectedYou: Battlesnake = {
    ...cloneSnake(state.you),
    head: cloneCoordinate(destination),
    body,
    health: healthAfterMove(state, destination),
    length: body.length,
  };
  const snakes = state.board.snakes.map((snake) =>
    snake.id === state.you.id ? projectedYou : cloneSnake(snake),
  );
  const projectedState: GameState = {
    game: {
      ...state.game,
      ruleset: {
        ...state.game.ruleset,
        settings: {
          ...state.game.ruleset.settings,
          ...(state.game.ruleset.settings.royale === undefined
            ? {}
            : { royale: { ...state.game.ruleset.settings.royale } }),
        },
      },
    },
    turn: state.turn + 1,
    board: {
      ...state.board,
      food: state.board.food
        .filter((food) => !sameCoordinate(food, destination))
        .map(cloneCoordinate),
      hazards: state.board.hazards.map(cloneCoordinate),
      snakes,
    },
    you: projectedYou,
  };
  const blocked = guaranteedOccupiedCells(projectedState);

  return { state: projectedState, snake: projectedYou, blocked };
}

/**
 * Performs a conservative, static spatial projection after one candidate move.
 * Opponent bodies do not move; opponent action uncertainty is deferred to the
 * opponent policy and MCTS phases.
 */
export function analyzeSpatialMove(
  state: GameState,
  direction: Direction,
): SpatialMoveAnalysis {
  const projection = projectOurMove(state, direction);
  const trap = analyzeTraps(
    projection.snake.head,
    projection.state.board.width,
    projection.state.board.height,
    projection.blocked,
    projection.snake.length,
  );
  const foodPath = shortestSurvivablePathToFood(
    projection.state,
    projection.snake,
    projection.blocked,
  );
  const safeFoodTarget = foodPath?.path.at(-1);
  const tailPath = shortestPathToOwnTail(
    projection.state,
    projection.snake,
    projection.blocked,
  );
  const territory = analyzeTerritory(projection.state, projection.blocked);
  const strongestOpponentTerritory = Math.max(
    0,
    ...projection.state.board.snakes
      .filter((snake) => snake.id !== projection.snake.id)
      .map((snake) => territoryCount(territory, snake.id)),
  );

  return {
    destination: cloneCoordinate(projection.snake.head),
    projectedHealth: projection.snake.health,
    trap,
    ...(foodPath === undefined ? {} : { safeFoodDistance: foodPath.distance }),
    ...(safeFoodTarget === undefined
      ? {}
      : { safeFoodTarget: cloneCoordinate(safeFoodTarget) }),
    ...(tailPath === undefined ? {} : { tailDistance: tailPath.distance }),
    ownedTerritory: territoryCount(territory, projection.snake.id),
    strongestOpponentTerritory,
    territoryAdvantage: blendedTerritoryAdvantage(
      projection.state,
      projection.snake.id,
      projection.blocked,
    ),
    contestedCells: territory.contested.size,
    offense: analyzeOffensiveMove(state, direction, projection),
  };
}
