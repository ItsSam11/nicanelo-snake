import type { Battlesnake, Coordinate, GameState } from "../src/api/types.js";

function snake(
  id: string,
  body: Coordinate[],
  health = 90,
): Battlesnake {
  const head = body[0];
  if (head === undefined) {
    throw new Error("A snake needs at least one body segment");
  }

  return {
    id,
    name: id,
    health,
    body,
    head,
    length: body.length,
  };
}

export function gameState(input?: {
  width?: number;
  height?: number;
  youBody?: Coordinate[];
  opponents?: Battlesnake[];
  food?: Coordinate[];
  hazards?: Coordinate[];
  health?: number;
}): GameState {
  const you = snake(
    "us",
    input?.youBody ?? [
      { x: 5, y: 5 },
      { x: 5, y: 4 },
      { x: 5, y: 3 },
    ],
    input?.health,
  );
  const opponents = input?.opponents ?? [];

  return {
    game: {
      id: "game-1",
      ruleset: {
        name: "standard",
        version: "test",
        settings: {
          foodSpawnChance: 15,
          minimumFood: 1,
          hazardDamagePerTurn: 14,
        },
      },
      map: "standard",
      source: "test",
      timeout: 500,
    },
    turn: 10,
    board: {
      width: input?.width ?? 11,
      height: input?.height ?? 11,
      food: input?.food ?? [],
      hazards: input?.hazards ?? [],
      snakes: [you, ...opponents],
    },
    you,
  };
}

export function opponent(id: string, body: Coordinate[]): Battlesnake {
  return snake(id, body);
}
