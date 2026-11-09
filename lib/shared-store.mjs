export class SharedStore {
  async create(kind, id, value) {
    return this.commit(kind, id, -1, value);
  }
  async mutate(kind, id, change) {
    for (let attempt = 0; attempt < 16; attempt++) {
      const record = await this.read(kind, id);
      if (!record)
        throw Object.assign(
          Error(
            kind === "room"
              ? "Room not found. Check your code."
              : "Start a new puzzle.",
          ),
          { status: 404 },
        );
      const oldStatus = record.value.status,
        next = record.value;
      if (change(next) === false) return next;
      const awards =
        kind === "room" &&
        next.status === "finished" &&
        oldStatus !== "finished"
          ? next.players.map((p) => [p.name, p.id === next.winner ? 10 : 1])
          : [];
      if (await this.commit(kind, id, record.version, next, awards))
        return next;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.floor(Math.random() * 20)),
      );
    }
    throw Object.assign(
      Error("The room is busy. Please try your move again."),
      { status: 503 },
    );
  }
}
