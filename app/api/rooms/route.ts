import { env } from "cloudflare:workers";

export const runtime = "edge";

type Rank = "S" | "A" | "B" | "C" | "D";
type Vote = { playerId: string; rank: Rank };
type Player = { id: string; name: string; score: number };
type RoomState = {
  code: string; theme: string; status: "lobby" | "voting" | "results"; hostId: string;
  players: Player[]; items: string[]; round: number; votes: Vote[]; results: { item: string; rank: Rank }[];
};

const themeItems: Record<string, string[]> = {
  anime: ["Shingeki no Kyojin", "Frieren", "Jujutsu Kaisen", "Spy × Family", "Chainsaw Man", "Vinland Saga", "Demon Slayer", "Cyberpunk: Edgerunners"],
  ghibli: ["El viaje de Chihiro", "La princesa Mononoke", "El castillo ambulante", "Mi vecino Totoro", "Nausicaä", "Ponyo", "El viento se levanta", "El cuento de la princesa Kaguya"],
  games: ["The Last of Us", "Elden Ring", "Minecraft", "Hades", "Zelda: Breath of the Wild", "Portal 2", "Red Dead Redemption 2", "Baldur's Gate 3"],
};
const rankValue: Record<Rank, number> = { S: 4, A: 3, B: 2, C: 1, D: 0 };
const valueRank: Rank[] = ["D", "C", "B", "A", "S"];

function db() {
  const database = env.DB;
  if (!database) throw new Error("Database unavailable");
  return database;
}

async function ensureTable() {
  await db().prepare(`CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
}

async function readRoom(code: string): Promise<RoomState | null> {
  await ensureTable();
  const row = await db().prepare("SELECT state FROM rooms WHERE code = ?").bind(code).first<{ state: string }>();
  return row ? JSON.parse(row.state) : null;
}

async function saveRoom(room: RoomState) {
  await db().prepare("INSERT OR REPLACE INTO rooms (code, state, updated_at) VALUES (?, ?, ?)")
    .bind(room.code, JSON.stringify(room), Date.now()).run();
}

function publicRoom(room: RoomState) {
  return {
    code: room.code, theme: room.theme, status: room.status, hostId: room.hostId,
    currentItem: room.status === "voting" ? room.items[room.round] : null,
    round: room.round, totalRounds: room.items.length, results: room.results,
    players: room.players.map((p) => ({ ...p, hasVoted: room.votes.some((v) => v.playerId === p.id) })),
  };
}

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function shuffled<T>(list: T[]) {
  return [...list].map((value) => ({ value, sort: Math.random() })).sort((a, b) => a.sort - b.sort).map(({ value }) => value);
}

export async function GET(request: Request) {
  try {
    const code = new URL(request.url).searchParams.get("code")?.toUpperCase() ?? "";
    const room = await readRoom(code);
    return room ? Response.json(publicRoom(room)) : Response.json({ error: "Sala no encontrada." }, { status: 404 });
  } catch {
    return Response.json({ error: "No pudimos cargar la sala." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?: string; playerId?: string; name?: string; theme?: string; code?: string; rank?: Rank };
    const playerId = body.playerId?.trim();
    if (!playerId) return Response.json({ error: "Falta identificar al jugador." }, { status: 400 });

    if (body.action === "create") {
      const name = body.name?.trim().slice(0, 18);
      const theme = body.theme && themeItems[body.theme] ? body.theme : "anime";
      if (!name) return Response.json({ error: "Escribe tu nombre." }, { status: 400 });
      let code = randomCode();
      while (await readRoom(code)) code = randomCode();
      const room: RoomState = { code, theme, status: "lobby", hostId: playerId, players: [{ id: playerId, name, score: 0 }], items: shuffled(themeItems[theme]), round: 0, votes: [], results: [] };
      await saveRoom(room);
      return Response.json(publicRoom(room), { status: 201 });
    }

    const code = body.code?.trim().toUpperCase() ?? "";
    const room = await readRoom(code);
    if (!room) return Response.json({ error: "No encontramos esa sala." }, { status: 404 });

    if (body.action === "join") {
      if (room.status !== "lobby") return Response.json({ error: "La partida ya comenzó." }, { status: 409 });
      const name = body.name?.trim().slice(0, 18);
      if (!name) return Response.json({ error: "Escribe tu nombre." }, { status: 400 });
      const existing = room.players.find((p) => p.id === playerId);
      if (existing) existing.name = name;
      else if (room.players.length < 12) room.players.push({ id: playerId, name, score: 0 });
      else return Response.json({ error: "La sala está llena." }, { status: 409 });
    } else if (body.action === "start") {
      if (room.hostId !== playerId) return Response.json({ error: "Solo el anfitrión puede comenzar." }, { status: 403 });
      room.status = "voting";
    } else if (body.action === "vote") {
      if (room.status !== "voting" || !body.rank || !(body.rank in rankValue)) return Response.json({ error: "Ese voto no es válido." }, { status: 400 });
      if (!room.players.some((p) => p.id === playerId)) return Response.json({ error: "No perteneces a esta sala." }, { status: 403 });
      if (!room.votes.some((v) => v.playerId === playerId)) room.votes.push({ playerId, rank: body.rank });
      if (room.votes.length === room.players.length) {
        const average = Math.round(room.votes.reduce((sum, v) => sum + rankValue[v.rank], 0) / room.votes.length);
        room.results.push({ item: room.items[room.round], rank: valueRank[average] });
        room.players.forEach((player) => {
          const vote = room.votes.find((v) => v.playerId === player.id)!;
          const distance = Math.abs(rankValue[vote.rank] - average);
          player.score += distance === 0 ? 100 : distance === 1 ? 50 : 0;
        });
        room.votes = [];
        room.round += 1;
        if (room.round >= room.items.length) room.status = "results";
      }
    } else {
      return Response.json({ error: "Acción no válida." }, { status: 400 });
    }
    await saveRoom(room);
    return Response.json(publicRoom(room));
  } catch {
    return Response.json({ error: "No pudimos actualizar la sala." }, { status: 500 });
  }
}
