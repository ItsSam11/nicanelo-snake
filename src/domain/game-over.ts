import type { GameState } from "../api/types.js";

export type GameResult = "ongoing" | "win" | "loss" | "draw";

export interface GameOutcome {
  gameOver: boolean;
  result: GameResult;
  winnerId?: string;
}

/** Returns the multiplayer Standard-rules result from our perspective. */
export function getGameOutcome(state: GameState): GameOutcome {
  const alive = state.board.snakes;

  if (alive.length > 1) {
    return { gameOver: false, result: "ongoing" };
  }

  const winner = alive[0];
  if (winner === undefined) {
    return { gameOver: true, result: "draw" };
  }

  return {
    gameOver: true,
    result: winner.id === state.you.id ? "win" : "loss",
    winnerId: winner.id,
  };
}
