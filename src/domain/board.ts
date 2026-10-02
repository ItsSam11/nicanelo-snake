import type { Coordinate, Direction, GameState } from "../api/types.js";

export const DIRECTIONS: readonly Direction[] = [
  "up",
  "down",
  "left",
  "right",
];

const OFFSETS: Readonly<Record<Direction, Coordinate>> = {
  up: { x: 0, y: 1 },
  down: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export function moveCoordinate(
  coordinate: Coordinate,
  direction: Direction,
): Coordinate {
  const offset = OFFSETS[direction];
  return {
    x: coordinate.x + offset.x,
    y: coordinate.y + offset.y,
  };
}

export function coordinateKey({ x, y }: Coordinate): string {
  return `${x},${y}`;
}

export function sameCoordinate(a: Coordinate, b: Coordinate): boolean {
  return a.x === b.x && a.y === b.y;
}

export function isInsideBoard(
  coordinate: Coordinate,
  width: number,
  height: number,
): boolean {
  return (
    coordinate.x >= 0 &&
    coordinate.x < width &&
    coordinate.y >= 0 &&
    coordinate.y < height
  );
}

/**
 * Returns cells that are guaranteed to remain occupied while a turn resolves.
 * Every unique final tail segment is omitted: Standard moves every snake before
 * feeding it, so the old tail vacates even when that snake eats. A duplicated
 * tail remains occupied because only one copy is removed by movement.
 */
export function guaranteedOccupiedCells(state: GameState): Set<string> {
  const occupied = new Set<string>();

  for (const snake of state.board.snakes) {
    const tailIndex = snake.body.length - 1;

    for (const [index, segment] of snake.body.entries()) {
      if (index === tailIndex) {
        const tailAppearsEarlier = snake.body
          .slice(0, tailIndex)
          .some((other) => sameCoordinate(other, segment));

        if (!tailAppearsEarlier) {
          continue;
        }
      }

      occupied.add(coordinateKey(segment));
    }
  }

  return occupied;
}

export function dangerousHeadToHeadCells(state: GameState): Set<string> {
  const dangerous = new Set<string>();
  const occupied = guaranteedOccupiedCells(state);
  const food = new Set(state.board.food.map(coordinateKey));
  const hazards = new Set(state.board.hazards.map(coordinateKey));

  for (const opponent of state.board.snakes) {
    if (opponent.id === state.you.id || opponent.length < state.you.length) {
      continue;
    }

    for (const direction of DIRECTIONS) {
      const candidate = moveCoordinate(opponent.head, direction);
      const candidateKey = coordinateKey(candidate);
      const healthAfterMove = food.has(candidateKey)
        ? 100
        : opponent.health - 1 -
          (hazards.has(candidateKey)
            ? state.game.ruleset.settings.hazardDamagePerTurn
            : 0);
      if (
        isInsideBoard(candidate, state.board.width, state.board.height) &&
        !occupied.has(candidateKey) &&
        healthAfterMove > 0
      ) {
        dangerous.add(candidateKey);
      }
    }
  }

  return dangerous;
}

export function countOpenNeighbours(
  origin: Coordinate,
  state: GameState,
  occupied: ReadonlySet<string>,
): number {
  return DIRECTIONS.reduce((count, direction) => {
    const candidate = moveCoordinate(origin, direction);
    const open =
      isInsideBoard(candidate, state.board.width, state.board.height) &&
      !occupied.has(coordinateKey(candidate));
    return count + Number(open);
  }, 0);
}

export function manhattanDistance(a: Coordinate, b: Coordinate): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}
