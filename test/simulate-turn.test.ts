import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Coordinate, Direction, GameState } from "../src/api/types.js";
import type { SnakeMoves } from "../src/domain/legal-moves.js";
import { simulateTurn } from "../src/domain/simulate-turn.js";
import { gameState, opponent } from "./fixtures.js";

const FAR_OPPONENT = opponent("them", [
  { x: 8, y: 8 },
  { x: 8, y: 7 },
  { x: 8, y: 6 },
]);

function activeState(input?: Parameters<typeof gameState>[0]): GameState {
  return gameState({ ...input, opponents: input?.opponents ?? [FAR_OPPONENT] });
}

function jointMoves(us: Direction, them: Direction): SnakeMoves {
  return { us, them };
}

function bodyOf(state: GameState, snakeId: string): Coordinate[] | undefined {
  return state.board.snakes.find((snake) => snake.id === snakeId)?.body;
}

describe("simulateTurn", () => {
  it("moves simultaneously, removes tails, reduces health, and advances the turn", () => {
    const state = activeState();
    const original = structuredClone(state);
    const result = simulateTurn(state, jointMoves("right", "left"));

    assert.equal(result.state.turn, 11);
    assert.deepEqual(bodyOf(result.state, "us"), [
      { x: 6, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 4 },
    ]);
    assert.deepEqual(bodyOf(result.state, "them"), [
      { x: 7, y: 8 },
      { x: 8, y: 8 },
      { x: 8, y: 7 },
    ]);
    assert.equal(result.state.you.health, 89);
    assert.deepEqual(state, original, "the input state must remain unchanged");
  });

  it("lets a snake at one health eat, restores health, grows, and removes food", () => {
    const result = simulateTurn(
      activeState({ health: 1, food: [{ x: 5, y: 6 }] }),
      jointMoves("up", "left"),
    );

    assert.equal(result.state.you.health, 100);
    assert.equal(result.state.you.length, 4);
    assert.deepEqual(result.state.you.body, [
      { x: 5, y: 6 },
      { x: 5, y: 5 },
      { x: 5, y: 4 },
      { x: 5, y: 4 },
    ]);
    assert.deepEqual(result.state.board.food, []);
  });

  it("keeps uneaten food on the next board", () => {
    const food = [{ x: 0, y: 0 }];
    const result = simulateTurn(
      activeState({ food }),
      jointMoves("up", "left"),
    );

    assert.deepEqual(result.state.board.food, food);
  });

  it("applies one health loss plus configured hazard damage", () => {
    const result = simulateTurn(
      activeState({ health: 50, hazards: [{ x: 5, y: 6 }] }),
      jointMoves("up", "left"),
    );

    assert.equal(result.state.you.health, 35);
    assert.deepEqual(result.eliminations, []);
  });

  it("does not apply hazard damage when food occupies the same square", () => {
    const destination = { x: 5, y: 6 };
    const result = simulateTurn(
      activeState({
        health: 1,
        food: [destination],
        hazards: [destination],
      }),
      jointMoves("up", "left"),
    );

    assert.equal(result.state.you.health, 100);
    assert.equal(result.state.you.length, 4);
    assert.deepEqual(result.eliminations, []);
  });

  it("removes a hazard death before resolving a head-to-head", () => {
    const result = simulateTurn(
      activeState({
        health: 10,
        hazards: [{ x: 5, y: 6 }],
        opponents: [
          opponent("them", [
            { x: 6, y: 6 },
            { x: 7, y: 6 },
            { x: 8, y: 6 },
          ]),
        ],
      }),
      jointMoves("up", "left"),
    );

    assert.deepEqual(result.eliminations, [
      { snakeId: "us", cause: "hazard" },
    ]);
    assert.equal(result.state.you.health, 0);
    assert.equal(result.outcome.result, "loss");
  });

  it("eliminates a snake that reaches zero health without food", () => {
    const result = simulateTurn(
      activeState({ health: 1 }),
      jointMoves("up", "left"),
    );

    assert.deepEqual(result.eliminations, [
      { snakeId: "us", cause: "out-of-health" },
    ]);
  });

  it("eliminates a snake that moves out of bounds", () => {
    const result = simulateTurn(
      activeState({
        width: 5,
        height: 5,
        youBody: [
          { x: 0, y: 2 },
          { x: 1, y: 2 },
          { x: 2, y: 2 },
        ],
        opponents: [opponent("them", [{ x: 4, y: 4 }])],
      }),
      jointMoves("left", "down"),
    );

    assert.deepEqual(result.eliminations, [
      { snakeId: "us", cause: "out-of-bounds" },
    ]);
  });

  it("detects self-collision after movement", () => {
    const result = simulateTurn(
      activeState({
        youBody: [
          { x: 2, y: 2 },
          { x: 2, y: 1 },
          { x: 1, y: 1 },
          { x: 1, y: 2 },
          { x: 1, y: 3 },
        ],
      }),
      jointMoves("left", "left"),
    );

    assert.deepEqual(result.eliminations, [
      { snakeId: "us", cause: "self-collision", bySnakeId: "us" },
    ]);
  });

  it("allows a snake to enter its own tail square when it vacates", () => {
    const result = simulateTurn(
      activeState({
        width: 5,
        height: 5,
        youBody: [
          { x: 1, y: 1 },
          { x: 1, y: 2 },
          { x: 2, y: 2 },
          { x: 2, y: 1 },
        ],
        opponents: [opponent("them", [{ x: 4, y: 4 }])],
      }),
      jointMoves("right", "left"),
    );

    assert.ok(result.state.board.snakes.some((snake) => snake.id === "us"));
  });

  it("allows entry into an opponent tail square when it vacates", () => {
    const result = simulateTurn(
      activeState({
        width: 6,
        height: 6,
        youBody: [
          { x: 1, y: 1 },
          { x: 1, y: 0 },
          { x: 0, y: 0 },
        ],
        opponents: [
          opponent("them", [
            { x: 3, y: 1 },
            { x: 3, y: 2 },
            { x: 2, y: 2 },
            { x: 2, y: 1 },
          ]),
        ],
      }),
      jointMoves("right", "right"),
    );

    assert.ok(result.state.board.snakes.some((snake) => snake.id === "us"));
  });

  it("keeps a duplicated tail occupied and resolves a body collision", () => {
    const result = simulateTurn(
      activeState({
        width: 6,
        height: 6,
        youBody: [
          { x: 1, y: 1 },
          { x: 1, y: 0 },
          { x: 0, y: 0 },
        ],
        opponents: [
          opponent("them", [
            { x: 3, y: 1 },
            { x: 3, y: 2 },
            { x: 2, y: 2 },
            { x: 2, y: 1 },
            { x: 2, y: 1 },
          ]),
        ],
      }),
      jointMoves("right", "right"),
    );

    assert.deepEqual(result.eliminations, [
      { snakeId: "us", cause: "body-collision", bySnakeId: "them" },
    ]);
  });

  it("eliminates a snake that enters another snake body", () => {
    const result = simulateTurn(
      activeState({
        youBody: [
          { x: 2, y: 2 },
          { x: 2, y: 1 },
          { x: 2, y: 0 },
        ],
        opponents: [
          opponent("them", [
            { x: 4, y: 2 },
            { x: 3, y: 2 },
            { x: 3, y: 1 },
          ]),
        ],
      }),
      jointMoves("right", "up"),
    );

    assert.deepEqual(result.eliminations, [
      { snakeId: "us", cause: "body-collision", bySnakeId: "them" },
    ]);
  });

  it("removes an out-of-bounds snake before its body causes collisions", () => {
    const result = simulateTurn(
      activeState({
        width: 7,
        height: 7,
        youBody: [
          { x: 3, y: 2 },
          { x: 3, y: 1 },
          { x: 2, y: 1 },
        ],
        opponents: [
          opponent("them", [
            { x: 0, y: 3 },
            { x: 1, y: 3 },
            { x: 2, y: 3 },
            { x: 3, y: 3 },
            { x: 3, y: 3 },
          ]),
        ],
      }),
      jointMoves("up", "left"),
    );

    assert.deepEqual(result.eliminations, [
      { snakeId: "them", cause: "out-of-bounds" },
    ]);
    assert.equal(result.outcome.result, "win");
  });

  it("eliminates equal snakes head-to-head and reports a draw", () => {
    const result = simulateTurn(
      activeState({
        youBody: [
          { x: 2, y: 1 },
          { x: 2, y: 0 },
          { x: 1, y: 0 },
        ],
        opponents: [
          opponent("them", [
            { x: 2, y: 3 },
            { x: 2, y: 4 },
            { x: 1, y: 4 },
          ]),
        ],
      }),
      jointMoves("up", "down"),
    );

    assert.deepEqual(result.eliminations, [
      { snakeId: "us", cause: "head-to-head", bySnakeId: "them" },
      { snakeId: "them", cause: "head-to-head", bySnakeId: "us" },
    ]);
    assert.deepEqual(result.state.board.snakes, []);
    assert.equal(result.outcome.result, "draw");
  });

  it("lets the strictly longer snake survive a head-to-head", () => {
    const result = simulateTurn(
      activeState({
        youBody: [
          { x: 2, y: 1 },
          { x: 2, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 0 },
        ],
        opponents: [
          opponent("them", [
            { x: 2, y: 3 },
            { x: 2, y: 4 },
            { x: 1, y: 4 },
          ]),
        ],
      }),
      jointMoves("up", "down"),
    );

    assert.deepEqual(result.eliminations, [
      { snakeId: "them", cause: "head-to-head", bySnakeId: "us" },
    ]);
    assert.equal(result.outcome.result, "win");
    assert.equal(result.outcome.winnerId, "us");
  });

  it("eliminates every snake in a three-way head tie for longest", () => {
    const state = gameState({
      youBody: [
        { x: 5, y: 4 },
        { x: 5, y: 3 },
        { x: 5, y: 2 },
        { x: 5, y: 1 },
      ],
      opponents: [
        opponent("them", [
          { x: 5, y: 6 },
          { x: 5, y: 7 },
          { x: 5, y: 8 },
          { x: 5, y: 9 },
        ]),
        opponent("third", [
          { x: 4, y: 5 },
          { x: 3, y: 5 },
          { x: 2, y: 5 },
        ]),
      ],
    });
    const result = simulateTurn(state, {
      us: "up",
      them: "down",
      third: "right",
    });

    assert.equal(result.eliminations.length, 3);
    assert.deepEqual(result.state.board.snakes, []);
    assert.equal(result.outcome.result, "draw");
  });

  it("feeds all snakes on contested food before head-to-head", () => {
    const food = [{ x: 2, y: 2 }];
    const them = opponent("them", [
      { x: 2, y: 3 },
      { x: 2, y: 4 },
      { x: 1, y: 4 },
    ]);
    them.health = 10;
    const result = simulateTurn(
      activeState({
        health: 10,
        food,
        youBody: [
          { x: 2, y: 1 },
          { x: 2, y: 0 },
          { x: 1, y: 0 },
        ],
        opponents: [them],
      }),
      jointMoves("up", "down"),
    );

    assert.deepEqual(result.state.board.food, []);
    assert.equal(result.state.you.health, 100);
    assert.equal(result.state.you.length, 4);
    assert.equal(result.outcome.result, "draw");
  });

  it("requires one valid move for every snake", () => {
    const state = activeState();

    assert.throws(
      () => simulateTurn(state, { us: "up" }),
      /Missing or invalid move for snake them/,
    );
    assert.throws(
      () =>
        simulateTurn(state, {
          us: "up",
          them: "left",
          ghost: "right",
        }),
      /Move supplied for unknown snake ghost/,
    );
  });

  it("does not advance a game that was already terminal", () => {
    const state = gameState();
    const result = simulateTurn(state, { us: "up" });

    assert.equal(result.state.turn, state.turn);
    assert.equal(result.outcome.result, "win");
    assert.notEqual(result.state, state);
  });

  it("rejects rulesets whose transition semantics are not implemented", () => {
    const state = activeState();
    state.game.ruleset.name = "wrapped";

    assert.throws(
      () => simulateTurn(state, jointMoves("up", "left")),
      /Unsupported ruleset for exact simulation: wrapped/,
    );
  });
});
