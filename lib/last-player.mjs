export function finishLastPlayer(room, remaining = room.players) {
  if (room.status !== "playing" || remaining.length !== 1) return false;
  const winner = room.players.find((p) => p.id === remaining[0].id);
  if (!winner) return false;
  room.status = "finished";
  room.winner = winner.id;
  room.finishReason = "last-player";
  room.host = winner.id;
  room.turn = null;
  winner.score++;
  return true;
}
