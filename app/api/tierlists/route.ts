import { env } from "cloudflare:workers";

export const runtime = "edge";

type Visibility = "public" | "private";
type Item = { name: string; image: string | null };
type TierlistRow = {
  id: string;
  name: string;
  items: string; // JSON en la base de datos
  owner_id: string;
  visibility: Visibility;
  created_at: number;
};

// Temáticas iniciales que se siembran como tierlists públicas del sistema.
const seedTierlists: { name: string; items: string[] }[] = [
  { name: "Anime esenciales", items: ["Shingeki no Kyojin", "Frieren", "Jujutsu Kaisen", "Spy × Family", "Chainsaw Man", "Vinland Saga", "Demon Slayer", "Cyberpunk: Edgerunners"] },
  { name: "Películas de Ghibli", items: ["El viaje de Chihiro", "La princesa Mononoke", "El castillo ambulante", "Mi vecino Totoro", "Nausicaä", "Ponyo", "El viento se levanta", "El cuento de la princesa Kaguya"] },
  { name: "Videojuegos inolvidables", items: ["The Last of Us", "Elden Ring", "Minecraft", "Hades", "Zelda: Breath of the Wild", "Portal 2", "Red Dead Redemption 2", "Baldur's Gate 3"] },
];

function db() {
  const database = env.DB;
  if (!database) throw new Error("Database unavailable");
  return database;
}

async function ensureTable() {
  await db().prepare(`CREATE TABLE IF NOT EXISTS tierlists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    items TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    visibility TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`).run();
}

async function seedIfEmpty() {
  const count = await db().prepare("SELECT COUNT(*) AS n FROM tierlists").first<{ n: number }>();
  if (count && count.n > 0) return;
  for (const seed of seedTierlists) {
    const items: Item[] = seed.items.map((name) => ({ name, image: null }));
    await db().prepare("INSERT INTO tierlists (id, name, items, owner_id, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), seed.name, JSON.stringify(items), "system", "public", Date.now()).run();
  }
}

// Convierte el JSON almacenado en una lista uniforme de {name, image},
// aceptando tanto el formato antiguo (strings) como el nuevo (objetos).
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

function toPublic(row: TierlistRow, userId: string) {
  return {
    id: row.id,
    name: row.name,
    items: parseItems(row.items),
    ownerId: row.owner_id,
    visibility: row.visibility,
    isOwner: row.owner_id === userId,
  };
}

// Limpia y valida los ítems que llegan del cliente.
function cleanItems(raw: unknown): Item[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((it): Item => {
      if (typeof it === "string") return { name: it.trim(), image: null };
      const obj = (it ?? {}) as { name?: unknown; image?: unknown };
      const name = typeof obj.name === "string" ? obj.name.trim() : "";
      let image = typeof obj.image === "string" ? obj.image : null;
      // Salvaguarda: descartar imágenes desproporcionadas (~700 KB de data URL).
      if (image && image.length > 700000) image = null;
      return { name, image };
    })
    .filter((it) => it.name.length > 0)
    .slice(0, 30);
}

export async function GET(request: Request) {
  try {
    await ensureTable();
    await seedIfEmpty();
    const url = new URL(request.url);
    const userId = url.searchParams.get("userId")?.trim() ?? "";
    const id = url.searchParams.get("id")?.trim();

    if (id) {
      const row = await db().prepare("SELECT * FROM tierlists WHERE id = ?").bind(id).first<TierlistRow>();
      if (!row) return Response.json({ error: "Tierlist no encontrada." }, { status: 404 });
      if (row.visibility === "private" && row.owner_id !== userId) {
        return Response.json({ error: "Esta tierlist es privada." }, { status: 403 });
      }
      return Response.json(toPublic(row, userId));
    }

    // Listado: todas las públicas + las privadas del propio usuario.
    const { results } = await db()
      .prepare("SELECT * FROM tierlists WHERE visibility = 'public' OR owner_id = ? ORDER BY created_at DESC")
      .bind(userId)
      .all<TierlistRow>();
    return Response.json((results ?? []).map((row: TierlistRow) => toPublic(row, userId)));
  } catch {
    return Response.json({ error: "No pudimos cargar las tierlists." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureTable();
    const body = await request.json() as {
      action?: string;
      userId?: string;
      id?: string;
      name?: string;
      items?: unknown;
      visibility?: Visibility;
    };
    const userId = body.userId?.trim();
    if (!userId) return Response.json({ error: "Falta identificar al usuario." }, { status: 400 });

    const name = body.name?.trim().slice(0, 60) ?? "";
    const items = cleanItems(body.items);
    const visibility: Visibility = body.visibility === "private" ? "private" : "public";

    if (body.action === "create") {
      if (!name) return Response.json({ error: "Ponle un nombre a la tierlist." }, { status: 400 });
      if (items.length < 2) return Response.json({ error: "Añade al menos 2 elementos." }, { status: 400 });
      const id = crypto.randomUUID();
      await db().prepare("INSERT INTO tierlists (id, name, items, owner_id, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id, name, JSON.stringify(items), userId, visibility, Date.now()).run();
      const row = await db().prepare("SELECT * FROM tierlists WHERE id = ?").bind(id).first<TierlistRow>();
      return Response.json(toPublic(row!, userId), { status: 201 });
    }

    if (body.action === "update") {
      const id = body.id?.trim();
      if (!id) return Response.json({ error: "Falta la tierlist a editar." }, { status: 400 });
      const existing = await db().prepare("SELECT * FROM tierlists WHERE id = ?").bind(id).first<TierlistRow>();
      if (!existing) return Response.json({ error: "Tierlist no encontrada." }, { status: 404 });
      if (existing.owner_id !== userId) {
        return Response.json({ error: "Solo el dueño puede modificar esta tierlist." }, { status: 403 });
      }
      if (!name) return Response.json({ error: "Ponle un nombre a la tierlist." }, { status: 400 });
      if (items.length < 2) return Response.json({ error: "Añade al menos 2 elementos." }, { status: 400 });
      await db().prepare("UPDATE tierlists SET name = ?, items = ?, visibility = ? WHERE id = ?")
        .bind(name, JSON.stringify(items), visibility, id).run();
      const row = await db().prepare("SELECT * FROM tierlists WHERE id = ?").bind(id).first<TierlistRow>();
      return Response.json(toPublic(row!, userId));
    }

    return Response.json({ error: "Acción no válida." }, { status: 400 });
  } catch {
    return Response.json({ error: "No pudimos guardar la tierlist." }, { status: 500 });
  }
}
