import { test } from "node:test";
import assert from "node:assert/strict";
import { finishLastPlayer } from "../lib/last-player.mjs";
const room = (status = "playing") => ({
  status,
  host: "a",
  turn: "a",
  players: [
    { id: "a", score: 0 },
    { id: "b", score: 0 },
  ],
  guesses: [{ word: "ocean" }],
});
test("only the last participant wins, once, while retaining guesses", () => {
  const r = room();
  assert.equal(finishLastPlayer(r), false);
  assert.equal(finishLastPlayer(r, []), false);
  assert.equal(finishLastPlayer(r, [r.players[1]]), true);
  assert.equal(r.status, "finished");
  assert.equal(r.winner, "b");
  assert.equal(r.host, "b");
  assert.equal(r.finishReason, "last-player");
  assert.equal(r.players[1].score, 1);
  assert.equal(r.guesses.length, 1);
  assert.equal(finishLastPlayer(r, [r.players[1]]), false);
  assert.equal(r.players[1].score, 1);
});
test("a waiting room cannot award a win to its sole participant", () => {
  const r = room("waiting");
  r.players.pop();
  assert.equal(finishLastPlayer(r), false);
  assert.equal(r.status, "waiting");
});
