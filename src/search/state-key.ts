import type { Coordinate, GameState } from "../api/types.js";

function compareCoordinates(a: Coordinate, b: Coordinate): number {
  return a.x - b.x || a.y - b.y;
}

function sortedCoordinates(coordinates: readonly Coordinate[]): Coordinate[] {
  return [...coordinates]
    .map(({ x, y }) => ({ x, y }))
    .sort(compareCoordinates);
}

/**
 * Canonical identity for every field that can affect Standard-rules search.
 * Presentation-only snake metadata is deliberately excluded.
 */
export function canonicalStateKey(state: GameState): string {
  const settings = state.game.ruleset.settings;
  return JSON.stringify({
    turn: state.turn,
    ruleset: {
      name: state.game.ruleset.name,
      version: state.game.ruleset.version,
      settings: {
        foodSpawnChance: settings.foodSpawnChance,
        minimumFood: settings.minimumFood,
        hazardDamagePerTurn: settings.hazardDamagePerTurn,
        royale: settings.royale === undefined
          ? undefined
          : { shrinkEveryNTurns: settings.royale.shrinkEveryNTurns },
      },
    },
    map: state.game.map,
    youId: state.you.id,
    board: {
      width: state.board.width,
      height: state.board.height,
      food: sortedCoordinates(state.board.food),
      hazards: sortedCoordinates(state.board.hazards),
      snakes: [...state.board.snakes]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((snake) => ({
          id: snake.id,
          health: snake.health,
          length: snake.length,
          body: snake.body.map(({ x, y }) => ({ x, y })),
        })),
    },
  });
}
