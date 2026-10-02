import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createBattlesnakeServer } from "../src/server.js";
import { gameState } from "./fixtures.js";

describe("Battlesnake HTTP API", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    server = createBattlesnakeServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("returns Battlesnake metadata from GET /", async () => {
    const response = await fetch(baseUrl);
    const body = (await response.json()) as { apiversion?: string };

    assert.equal(response.status, 200);
    assert.equal(body.apiversion, "1");
  });

  it("returns a move from POST /move", async () => {
    const response = await fetch(`${baseUrl}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(gameState()),
    });
    const body = (await response.json()) as { move?: Direction };

    assert.equal(response.status, 200);
    assert.ok(body.move !== undefined && DIRECTIONS.has(body.move));
  });

  it("rejects malformed JSON without crashing", async () => {
    const response = await fetch(`${baseUrl}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });

    assert.equal(response.status, 400);
  });
});

type Direction = "up" | "down" | "left" | "right";
const DIRECTIONS = new Set<Direction>(["up", "down", "left", "right"]);
