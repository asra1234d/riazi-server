import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;

/* ---------- سرور HTTP ساده (برای health check و سرو استاتیک) ---------- */
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, path: "/ws" });

/* ---------- ابزارها ---------- */
let seq = 1;
const uid = () => "p" + seq++ + Math.random().toString(36).slice(2, 6);
const rooms = new Map();

const send = (ws, obj) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
};
const broadcast = (room, obj, exceptId = null) => {
  for (const p of room.players.values()) {
    if (p.id !== exceptId) send(p.ws, obj);
  }
};
const playerList = (room) =>
  [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    seed: p.seed,
    ready: p.ready,
    score: p.score,
  }));

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "";
  do {
    c = Array.from(
      { length: 4 },
      () => chars[(Math.random() * chars.length) | 0],
    ).join("");
  } while (rooms.has(c));
  return c;
}

function newRoom(code) {
  const room = {
    code,
    hostId: null,
    players: new Map(),
    settings: { diff: 2, count: 10, time: 30 },
    questions: [],
    qIndex: -1,
    state: "lobby",
    timer: null,
    revealing: false,
  };
  rooms.set(code, room);
  return room;
}

/* ---------- منطق بازی ---------- */
function startGame(room) {
  clearTimeout(room.timer);
  room.players.forEach((p) => {
    p.score = 0;
    p.answers = {};
  });
  room.qIndex = -1;
  room.state = "playing";
  room.revealing = false;
  broadcast(room, {
    t: "start",
    questions: room.questions,
    settings: room.settings,
  });
  setTimeout(() => nextQuestion(room), 500);
}

function nextQuestion(room) {
  clearTimeout(room.timer);
  room.revealing = false;
  room.qIndex++;

  if (room.qIndex >= room.questions.length) return finishGame(room);

  const q = room.questions[room.qIndex];
  broadcast(room, {
    t: "question",
    i: room.qIndex,
    q: q.q,
    o: q.o,
    duration: room.settings.time,
  });

  room.timer = setTimeout(
    () => revealNow(room),
    room.settings.time * 1000 + 400,
  );
}

function recordAnswer(room, player, i, choice, ms) {
  if (room.state !== "playing" || i !== room.qIndex) return;
  if (player.answers[i]) return;
  const q = room.questions[i];
  const ok = choice === q.a;
  const time = room.settings.time * 1000;
  player.answers[i] = { choice, ms, ok };
  if (ok) player.score += Math.round(100 + 100 * Math.max(0, 1 - ms / time));

  broadcast(room, { t: "answered", id: player.id, i });

  const all = [...room.players.values()].every((p) => p.answers[i]);
  if (all && !room.revealing) {
    clearTimeout(room.timer);
    room.timer = setTimeout(() => revealNow(room), 500);
  }
}

function revealNow(room) {
  if (room.revealing) return;
  room.revealing = true;
  clearTimeout(room.timer);

  const i = room.qIndex;
  const q = room.questions[i];
  const answers = [...room.players.values()].map((p) => {
    const a = p.answers[i];
    return {
      id: p.id,
      choice: a ? a.choice : -1,
      ok: a ? a.ok : false,
      ms: a ? a.ms : null,
    };
  });

  broadcast(room, { t: "reveal", i, correct: q.a, answers });
  broadcast(room, { t: "players", players: playerList(room) });

  room.timer = setTimeout(() => nextQuestion(room), 3200);
}

function finishGame(room) {
  room.state = "finished";
  clearTimeout(room.timer);

  const standings = [...room.players.values()]
    .map((p) => {
      const arr = room.questions.map((q, i) => {
        const a = p.answers[i];
        return {
          choice: a ? a.choice : -1,
          ok: a ? a.ok : false,
          ms: a ? a.ms : null,
        };
      });
      const correct = arr.filter((x) => x.ok).length;
      const times = arr.filter((x) => x.ms != null).map((x) => x.ms);
      return {
        id: p.id,
        name: p.name,
        seed: p.seed,
        score: p.score,
        correct,
        total: room.questions.length,
        avgMs: times.length
          ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
          : 0,
        answers: arr,
      };
    })
    .sort(
      (a, b) => b.score - a.score || b.correct - a.correct || a.avgMs - b.avgMs,
    );

  broadcast(room, { t: "finish", standings, total: room.questions.length });
  room.qIndex = -1;
  room.players.forEach((p) => (p.ready = false));
  broadcast(room, { t: "players", players: playerList(room) });
}

/* ---------- اتصال‌ها ---------- */
wss.on("connection", (ws) => {
  let ctx = null; // { room, player }

  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!m || typeof m.t !== "string") return;

    try {
      /* ---- پیوستن ---- */
      if (m.t === "join") {
        let code = String(m.room || "")
          .toUpperCase()
          .slice(0, 6);
        let room = code ? rooms.get(code) : null;
        if (!room) {
          code = code || makeCode();
          room = newRoom(code);
        }
        if (room.state === "playing") {
          return send(ws, { t: "error", msg: "امتحان در جریان است" });
        }

        const id = uid();
        const player = {
          id,
          name: String(m.name || "بازیکن").slice(0, 14),
          seed: Number(m.seed) || (Math.random() * 900) | 0,
          ready: false,
          score: 0,
          answers: {},
          ws,
        };
        room.players.set(id, player);
        if (!room.hostId) room.hostId = id;

        ctx = { room, player };

        send(ws, {
          t: "joined",
          id,
          room: room.code,
          hostId: room.hostId,
          players: playerList(room),
          settings: room.settings,
        });
        broadcast(room, { t: "players", players: playerList(room) }, id);
        return;
      }

      if (!ctx) return;
      const { room, player } = ctx;

      switch (m.t) {
        case "ready":
          player.ready = !!m.v;
          broadcast(room, { t: "players", players: playerList(room) });
          break;

        case "settings":
          if (room.hostId !== player.id) return;
          if (room.state === "playing") return;
          Object.assign(room.settings, m.settings || {});
          broadcast(room, { t: "settings", settings: room.settings });
          break;

        case "start":
          if (room.hostId !== player.id) return;
          if (room.state === "playing") return;
          if (![...room.players.values()].every((p) => p.ready)) return;
          room.questions = Array.isArray(m.questions)
            ? m.questions.slice(0, 50)
            : [];
          if (room.questions.length === 0) return;
          startGame(room);
          break;

        case "answer":
          recordAnswer(room, player, m.i, m.choice, m.ms);
          break;

        case "chat":
          if (room.state === "playing") return;
          broadcast(room, {
            t: "chat",
            from: player.id,
            name: player.name,
            text: String(m.text || "").slice(0, 200),
            ts: Date.now(),
          });
          break;

        case "signal":
          if (m.to) {
            const target = room.players.get(m.to);
            if (target)
              send(target.ws, { t: "signal", from: player.id, data: m.data });
          }
          break;

        case "leave":
          ws.close();
          break;
      }
    } catch (e) {
      console.error("msg error", e);
    }
  });

  ws.on("close", () => {
    if (!ctx) return;
    const { room, player } = ctx;
    room.players.delete(player.id);
    if (room.players.size === 0) {
      clearTimeout(room.timer);
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === player.id) room.hostId = [...room.players.keys()][0];
    broadcast(room, { t: "players", players: playerList(room) });
    broadcast(room, { t: "host", hostId: room.hostId });
  });
});

server.listen(PORT, () => {
  console.log(`✅ Riazi Quest server → ws://localhost:${PORT}/ws`);
});
