import { env } from "cloudflare:workers";

export const runtime = "edge";

type Rank = "S" | "A" | "B" | "C" | "D";
type Item = { name: string; image: string | null };
type Vote = { playerId: string; rank: Rank };
type Player = { id: string; name: string; score: number };
type RoomState = {
  code: string; theme: string; status: "lobby" | "voting" | "results"; hostId: string;
  players: Player[]; items: Item[]; round: number; votes: Vote[];
  results: { item: string; rank: Rank | null }[]; roundEndsAt: number;
};

// Orden de mayor a menor: S(0) A(1) B(2) C(3) D(4)
const order: Rank[] = ["S", "A", "B", "C", "D"];
const ROUND_MS = 5000;

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

function parseItems(raw: string): Item[] {
  let arr: unknown;
  try { arr = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((it): Item => {
      if (typeof it === "string") return { name: it, image: null };
      const obj = it as { name?: unknown; image?: unknown };
      return {
        name: typeof obj.name === "string" ? obj.name : "",
        image: typeof obj.image === "string" ? obj.image : null,
      };
    })
    .filter((it) => it.name.length > 0);
}

async function readTierlist(id: string): Promise<{ name: string; items: Item[] } | null> {
  const row = await db().prepare("SELECT name, items FROM tierlists WHERE id = ?").bind(id).first<{ name: string; items: string }>();
  if (!row) return null;
  return { name: row.name, items: parseItems(row.items) };
}

// --- Puntuación por mayoría (DEMOCRATIER) ---
// Devuelve los puntos que gana cada rango y el rango final del elemento.
function scoreRound(votes: Vote[]): { points: Record<Rank, number>; finalRank: Rank | null } {
  const counts: Record<Rank, number> = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  for (const v of votes) counts[v.rank]++;
  const points: Record<Rank, number> = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  if (votes.length === 0) return { points, finalRank: null };

  const cnt = (i: number) => counts[order[i]];
  const maxVotes = Math.max(...order.map((r) => counts[r]));
  const top: number[] = order.map((_, i) => i).filter((i) => cnt(i) === maxVotes); // ordenados de mayor a menor rango

  // El rango final = el de mayor puntaje; a igualdad, el rango más alto.
  const finalFromPoints = (): Rank | null => {
    const maxPts = Math.max(...order.map((r) => points[r]));
    if (maxPts <= 0) return null;
    const winner = order.find((r) => points[r] === maxPts);
    return winner ?? null;
  };

  // Vecino válido: adyacente que no sea el otro empatado. Si hay dos, el de más
  // votos (y a igualdad, el rango más alto). null si no existe (borde).
  const pickNeighbor = (i: number, exclude: number): number | null => {
    const cands = [i - 1, i + 1].filter((j) => j >= 0 && j <= 4 && j !== exclude);
    if (cands.length === 0) return null;
    cands.sort((a, b) => cnt(b) - cnt(a) || a - b);
    return cands[0];
  };

  // Caso 1: un único rango con más votos (la moda). 3 al ganador, 1 a los adyacentes.
  if (top.length === 1) {
    const w = top[0];
    points[order[w]] = 3;
    for (const j of [w - 1, w + 1]) if (j >= 0 && j <= 4) points[order[j]] = 1;
    return { points, finalRank: order[w] };
  }

  // Caso 2: empate de dos rangos.
  if (top.length === 2) {
    const ai = top[0]; // rango más alto de los dos
    const bi = top[1];
    const na = pickNeighbor(ai, bi);
    const nb = pickNeighbor(bi, ai);

    // Borde (S/A o C/D): un empatado no tiene vecino exterior -> ambos 2, el
    // adyacente exterior del no-extremo 1.
    if (na === null || nb === null) {
      points[order[ai]] = 2;
      points[order[bi]] = 2;
      const nonExtreme = na === null ? bi : ai;
      const other = na === null ? ai : bi;
      const side = pickNeighbor(nonExtreme, other);
      if (side !== null) points[order[side]] = 1;
      return { points, finalRank: order[ai] };
    }

    const sumA = cnt(ai) + cnt(na);
    const sumB = cnt(bi) + cnt(nb);

    // Empate entre bloques: los cuatro implicados 1, resto 0.
    if (sumA === sumB) {
      for (const j of [ai, na, bi, nb]) points[order[j]] = 1;
      return { points, finalRank: finalFromPoints() };
    }

    // Gana el bloque mayor: rango empatado ganador 3, su vecino 2.
    const winMain = sumA > sumB ? ai : bi;
    const winNb = sumA > sumB ? na : nb;
    points[order[winMain]] = 3;
    points[order[winNb]] = 2;
    return { points, finalRank: order[winMain] };
  }

  // Caso 3: tres o más rangos empatados -> todos los empatados 1.
  for (const i of top) points[order[i]] = 1;
  return { points, finalRank: finalFromPoints() };
}

// Aplica el resultado de la ronda actual y avanza.
function closeRound(room: RoomState) {
  const { points, finalRank } = scoreRound(room.votes);
  room.results.push({ item: room.items[room.round].name, rank: finalRank });
  room.players.forEach((player) => {
    const vote = room.votes.find((v) => v.playerId === player.id);
    if (vote) player.score += points[vote.rank]; // quien no votó a tiempo: 0
  });
  room.votes = [];
  room.round += 1;
  if (room.round >= room.items.length) room.status = "results";
  else room.roundEndsAt = Date.now() + ROUND_MS;
}

// Resuelve las rondas cuyo tiempo ya expiró. Devuelve true si cambió el estado.
function resolveExpired(room: RoomState): boolean {
  let changed = false;
  while (room.status === "voting" && Date.now() >= room.roundEndsAt) {
    closeRound(room);
    changed = true;
  }
  return changed;
}

function publicRoom(room: RoomState) {
  return {
    code: room.code, theme: room.theme, status: room.status, hostId: room.hostId,
    currentItem: room.status === "voting" ? room.items[room.round] : null,
    round: room.round, totalRounds: room.items.length, results: room.results,
    msLeft: room.status === "voting" ? Math.max(0, room.roundEndsAt - Date.now()) : 0,
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
    if (!room) return Response.json({ error: "Sala no encontrada." }, { status: 404 });
    if (resolveExpired(room)) await saveRoom(room);
    return Response.json(publicRoom(room));
  } catch {
    return Response.json({ error: "No pudimos cargar la sala." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?: string; playerId?: string; name?: string; tierlistId?: string; code?: string; rank?: Rank };
    const playerId = body.playerId?.trim();
    if (!playerId) return Response.json({ error: "Falta identificar al jugador." }, { status: 400 });

    if (body.action === "create") {
      const name = body.name?.trim().slice(0, 18);
      if (!name) return Response.json({ error: "Escribe tu nombre." }, { status: 400 });
      const tierlistId = body.tierlistId?.trim();
      if (!tierlistId) return Response.json({ error: "Elige una tierlist." }, { status: 400 });
      const tierlist = await readTierlist(tierlistId);
      if (!tierlist || tierlist.items.length < 2) return Response.json({ error: "Esa tierlist no está disponible." }, { status: 400 });
      let code = randomCode();
      while (await readRoom(code)) code = randomCode();
      const room: RoomState = { code, theme: tierlist.name, status: "lobby", hostId: playerId, players: [{ id: playerId, name, score: 0 }], items: shuffled(tierlist.items), round: 0, votes: [], results: [], roundEndsAt: 0 };
      await saveRoom(room);
      return Response.json(publicRoom(room), { status: 201 });
    }

    const code = body.code?.trim().toUpperCase() ?? "";
    const room = await readRoom(code);
    if (!room) return Response.json({ error: "No encontramos esa sala." }, { status: 404 });
    resolveExpired(room);

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
      if (room.status === "lobby") {
        room.status = "voting";
        room.roundEndsAt = Date.now() + ROUND_MS;
      }
    } else if (body.action === "vote") {
      if (room.status !== "voting") return Response.json({ error: "La votación no está activa." }, { status: 400 });
      if (Date.now() >= room.roundEndsAt) return Response.json({ error: "Se acabó el tiempo." }, { status: 409 });
      if (!body.rank || !order.includes(body.rank)) return Response.json({ error: "Ese voto no es válido." }, { status: 400 });
      if (!room.players.some((p) => p.id === playerId)) return Response.json({ error: "No perteneces a esta sala." }, { status: 403 });
      if (!room.votes.some((v) => v.playerId === playerId)) room.votes.push({ playerId, rank: body.rank });
    } else {
      return Response.json({ error: "Acción no válida." }, { status: 400 });
    }
    await saveRoom(room);
    return Response.json(publicRoom(room));
  } catch {
    return Response.json({ error: "No pudimos actualizar la sala." }, { status: 500 });
  }
}
