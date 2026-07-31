"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Rank = "S" | "A" | "B" | "C" | "D";
type Item = { name: string; image: string | null };
type Player = { id: string; name: string; score: number; hasVoted: boolean };
type Result = { item: string; rank: Rank | null };
type Room = {
  code: string;
  theme: string;
  status: "lobby" | "voting" | "results";
  hostId: string;
  players: Player[];
  currentItem: Item | null;
  round: number;
  totalRounds: number;
  results: Result[];
  msLeft: number;
};
type Tierlist = {
  id: string;
  name: string;
  items: Item[];
  ownerId: string;
  visibility: "public" | "private";
  isOwner: boolean;
};

const ranks: Rank[] = ["S", "A", "B", "C", "D"];
const rankCopy: Record<Rank, string> = {
  S: "Obra maestra",
  A: "Excelente",
  B: "Muy bueno",
  C: "Está bien",
  D: "No convence",
};

function getPlayerId() {
  let id = localStorage.getItem("tierverse-player");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("tierverse-player", id);
  }
  return id;
}

// Lee una imagen del dispositivo y la reduce a una miniatura ligera (~256px, JPEG).
async function fileToThumb(file: File): Promise<string> {
  const dataUrl: string = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("read"));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("img"));
    image.src = dataUrl;
  });
  const max = 256;
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.82);
}

export default function Home() {
  const [view, setView] = useState<"home" | "detail" | "form" | "room">("home");
  const [modal, setModal] = useState<"" | "join" | "createRoom">("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [room, setRoom] = useState<Room | null>(null);
  const [playerId, setPlayerId] = useState("");
  const [selected, setSelected] = useState<Rank | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  const [tierlists, setTierlists] = useState<Tierlist[]>([]);
  const [active, setActive] = useState<Tierlist | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<{ name: string; items: Item[]; visibility: "public" | "private" }>({
    name: "",
    items: [{ name: "", image: null }, { name: "", image: null }],
    visibility: "public",
  });

  // Reloj local para la cuenta atrás (se resincroniza con el servidor en cada sondeo).
  const [nowMs, setNowMs] = useState(() => Date.now());
  const deadlineRef = useRef(0);

  useEffect(() => setPlayerId(getPlayerId()), []);

  // Tema: recupera la preferencia guardada o usa la del sistema.
  useEffect(() => {
    const saved = localStorage.getItem("tierverse-theme");
    const initial: "light" | "dark" =
      saved === "dark" || saved === "light"
        ? saved
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    setTheme(initial);
    document.documentElement.setAttribute("data-theme", initial);
  }, []);

  function toggleTheme() {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("tierverse-theme", next);
      return next;
    });
  }

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 200);
    return () => clearInterval(t);
  }, []);

  const loadTierlists = useCallback(async (uid: string) => {
    try {
      const res = await fetch(`/api/tierlists?userId=${uid}`, { cache: "no-store" });
      if (!res.ok) return;
      setTierlists((await res.json()) as Tierlist[]);
    } catch {
      /* silencio: la portada sigue usable sin la lista */
    }
  }, []);

  useEffect(() => {
    if (playerId) loadTierlists(playerId);
  }, [playerId, loadTierlists]);

  const loadRoom = useCallback(async (roomCode: string, quiet = false) => {
    try {
      const response = await fetch(`/api/rooms?code=${roomCode}`, { cache: "no-store" });
      if (!response.ok) return;
      const next = (await response.json()) as Room;
      setRoom(next);
      if (next.status !== "voting" || !next.players.find((p) => p.id === playerId)?.hasVoted) setSelected(null);
      if (!quiet) setView("room");
    } catch {
      if (!quiet) setError("No pudimos conectar con la sala.");
    }
  }, [playerId]);

  useEffect(() => {
    if (!room?.code) return;
    const timer = setInterval(() => loadRoom(room.code, true), 1500);
    return () => clearInterval(timer);
  }, [room?.code, loadRoom]);

  // Fija el instante de cierre a partir del tiempo restante que informa el servidor.
  useEffect(() => {
    if (room && room.status === "voting") deadlineRef.current = Date.now() + (room.msLeft ?? 0);
    else deadlineRef.current = 0;
  }, [room?.msLeft, room?.round, room?.status]);

  const msLeftLocal = room?.status === "voting" ? Math.max(0, deadlineRef.current - nowMs) : 0;
  const secondsLeft = Math.ceil(msLeftLocal / 1000);
  const timeFrac = Math.max(0, Math.min(1, msLeftLocal / 5000));

  async function action(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, playerId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Algo salió mal.");
      setRoom(data);
      setCode(data.code);
      setModal("");
      setView("room");
      return data as Room;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Algo salió mal.");
    } finally {
      setBusy(false);
    }
  }

  async function saveTierlist() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/tierlists", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: editingId ? "update" : "create",
          id: editingId ?? undefined,
          userId: playerId,
          name: form.name,
          items: form.items,
          visibility: form.visibility,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "No pudimos guardar la tierlist.");
      await loadTierlists(playerId);
      setActive(data as Tierlist);
      setView("detail");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No pudimos guardar la tierlist.");
    } finally {
      setBusy(false);
    }
  }

  function openCreateForm() {
    setEditingId(null);
    setForm({ name: "", items: [{ name: "", image: null }, { name: "", image: null }], visibility: "public" });
    setError("");
    setView("form");
  }

  function openEditForm(tl: Tierlist) {
    setError("");
    if (tl.isOwner) {
      setEditingId(tl.id);
      setForm({ name: tl.name, items: tl.items.map((it) => ({ ...it })), visibility: tl.visibility });
    } else {
      setEditingId(null);
      setForm({ name: `${tl.name} (mi versión)`, items: tl.items.map((it) => ({ ...it })), visibility: "public" });
    }
    setView("form");
  }

  function openDetail(tl: Tierlist) {
    setActive(tl);
    setError("");
    setView("detail");
  }

  function goHome() {
    setRoom(null);
    setActive(null);
    setModal("");
    setError("");
    setView("home");
  }

  const me = room?.players.find((p) => p.id === playerId);
  const isHost = room?.hostId === playerId;
  const voted = Boolean(me?.hasVoted);
  const waiting = room?.players.filter((p) => p.hasVoted).length ?? 0;
  const winner = useMemo(() => room?.players.slice().sort((a, b) => b.score - a.score)[0], [room]);

  const Brand = ({ as = "div" }: { as?: "div" | "button" }) => {
    const inner = (
      <>
        <span>DEMOCRATIER</span>
        <img className="mascot" src="/mascot.png" alt="Mascota de DEMOCRATIER" />
      </>
    );
    return as === "button" ? (
      <button className="brand" onClick={goHome} aria-label="Volver al inicio">{inner}</button>
    ) : (
      <div className="brand">{inner}</div>
    );
  };

  const ThemeToggle = () => (
    <button className="themeBtn" onClick={toggleTheme} aria-label="Cambiar entre modo claro y oscuro" title="Modo claro / oscuro">
      {theme === "dark" ? "☀" : "☾"}
    </button>
  );

  function JoinModal() {
    return (
      <div className="modalBackdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) setModal(""); }}>
        <section className="modal">
          <button className="close" onClick={() => setModal("")} aria-label="Cerrar">×</button>
          <p className="eyebrow">ENTRAR A UNA SALA</p>
          <h2>Únete al ranking.</h2>
          <label>Tu nombre<input value={name} maxLength={18} onChange={(e) => setName(e.target.value)} placeholder="Ej. Manu" autoFocus /></label>
          <label>Código de sala<input className="codeInput" value={code} maxLength={5} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCDE" /></label>
          <button className="primaryButton wide" disabled={!name.trim() || code.length < 5 || busy} onClick={() => action({ action: "join", name, code })}>{busy ? "Entrando…" : "Entrar a la sala"} <span>→</span></button>
          {error && <p className="error">{error}</p>}
        </section>
      </div>
    );
  }

  function CreateRoomModal() {
    return (
      <div className="modalBackdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) setModal(""); }}>
        <section className="modal">
          <button className="close" onClick={() => setModal("")} aria-label="Cerrar">×</button>
          <p className="eyebrow">NUEVA PARTIDA</p>
          <h2>Prepara la discusión.</h2>
          <div className="themePill"><span>◆</span><div><small>TIERLIST</small><strong>{active?.name}</strong></div></div>
          <label>Tu nombre<input value={name} maxLength={18} onChange={(e) => setName(e.target.value)} placeholder="Ej. Manu" autoFocus /></label>
          <button className="primaryButton wide" disabled={!name.trim() || busy || !active} onClick={() => action({ action: "create", name, tierlistId: active?.id })}>{busy ? "Creando…" : "Crear sala"} <span>→</span></button>
          {error && <p className="error">{error}</p>}
        </section>
      </div>
    );
  }

  // ---------- SALA ----------
  if (view === "room" && room) {
    return (
      <main className="appShell">
        <nav className="topbar">
          {Brand({ as: "button" })}
          <div className="navRight">
            {ThemeToggle()}
            <div className="roomMeta">
              <span className="liveDot" /> Sala <strong>{room.code}</strong>
              <button className="copyButton" onClick={() => { navigator.clipboard.writeText(room.code); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
                {copied ? "Copiado" : "Copiar código"}
              </button>
            </div>
          </div>
        </nav>

        {room.status === "lobby" && (
          <section className="roomLayout lobbyView">
            <div className="mainCard">
              <p className="eyebrow">SALA DE ESPERA</p>
              <h1>Todo listo para<br /><em>poner orden.</em></h1>
              <p className="lead">Comparte el código con tus amigos. Cada elemento se vota en 5 segundos, así que estad atentos.</p>
              <div className="themePill"><span>◆</span><div><small>TIERLIST</small><strong>{room.theme}</strong></div></div>
              {isHost ? (
                <button className="primaryButton wide" disabled={busy || room.players.length < 1} onClick={() => action({ action: "start", code: room.code })}>
                  Empezar la partida <span>→</span>
                </button>
              ) : <div className="waitingHost"><span className="spinner" /> Esperando al anfitrión…</div>}
            </div>
            <aside className="playersPanel">
              <div className="panelTitle"><span>Jugadores</span><b>{room.players.length}</b></div>
              {room.players.map((p, index) => (
                <div className="playerRow" key={p.id}>
                  <span className={`avatar a${index % 5}`}>{p.name.slice(0, 2).toUpperCase()}</span>
                  <strong>{p.name}{p.id === playerId && <small> tú</small>}</strong>
                  {p.id === room.hostId && <span className="hostTag">ANFITRIÓN</span>}
                </div>
              ))}
              <div className="inviteHint">Usa el código <strong>{room.code}</strong> para invitar a más jugadores.</div>
            </aside>
          </section>
        )}

        {room.status === "voting" && (
          <section className="voteView">
            <div className="roundHeader">
              <div><p className="eyebrow">RONDA {room.round + 1} DE {room.totalRounds}</p><h2>{room.theme}</h2></div>
              <div className="timerWrap">
                <div className={`timerNum ${secondsLeft <= 2 ? "low" : ""}`}>{secondsLeft}</div>
                <div className="progress"><span style={{ width: `${((room.round + 1) / room.totalRounds) * 100}%` }} /></div>
              </div>
            </div>
            <div className="subjectCard">
              <span className="subjectIndex">{String(room.round + 1).padStart(2, "0")}</span>
              <div className="subjectArt">{room.currentItem?.image ? <img src={room.currentItem.image} alt="" /> : room.currentItem?.name?.slice(0, 1)}</div>
              <div><small>¿DÓNDE LO PONDRÍAS?</small><h1>{room.currentItem?.name}</h1><p>Tu voto es privado hasta que todos hayan elegido.</p></div>
            </div>
            <div className="timeBar"><span className={secondsLeft <= 2 ? "low" : ""} style={{ width: `${timeFrac * 100}%` }} /></div>
            <div className="rankGrid">
              {ranks.map((rank) => (
                <button key={rank} className={`rankButton rank${rank} ${selected === rank ? "selected" : ""}`} disabled={voted || busy || msLeftLocal <= 0}
                  onClick={() => { setSelected(rank); action({ action: "vote", code: room.code, rank }); }}>
                  <strong>{rank}</strong><span>{rankCopy[rank]}</span>
                </button>
              ))}
            </div>
            <div className="voteStatus">
              <div className="miniAvatars">{room.players.map((p, i) => <span key={p.id} className={`avatar a${i % 5} ${p.hasVoted ? "done" : ""}`}>{p.name[0]}</span>)}</div>
              <p>{msLeftLocal <= 0 ? "¡Se acabó el tiempo! " : voted ? "¡Voto enviado! " : ""}<strong>{waiting} de {room.players.length}</strong> jugadores han votado</p>
            </div>
          </section>
        )}

        {room.status === "results" && (
          <section className="resultsView">
            <p className="eyebrow">RESULTADOS FINALES</p>
            <h1>La lista está <em>decidida.</em></h1>
            <div className="winnerCard"><span>♛</span><div><small>CAMPEÓN DE LA SALA</small><h2>{winner?.name}</h2></div><strong>{winner?.score} pts</strong></div>
            <div className="resultsGrid">
              <div className="tierBoard">
                {ranks.map((rank) => (
                  <div className={`tierRow tier${rank}`} key={rank}>
                    <strong>{rank}</strong>
                    <div>{room.results.filter((r) => r.rank === rank).map((r) => <span key={r.item}>{r.item}</span>)}</div>
                  </div>
                ))}
              </div>
              <div className="scoreboard">
                <div className="panelTitle"><span>Clasificación</span><b>PUNTOS</b></div>
                {room.players.slice().sort((a, b) => b.score - a.score).map((p, i) => (
                  <div className="scoreRow" key={p.id}><span className="position">0{i + 1}</span><span className={`avatar a${i % 5}`}>{p.name[0]}</span><strong>{p.name}</strong><b>{p.score}</b></div>
                ))}
              </div>
            </div>
            <button className="secondaryButton" onClick={goHome}>Volver al inicio</button>
          </section>
        )}
      </main>
    );
  }

  // ---------- DETALLE DE TIERLIST ----------
  if (view === "detail" && active) {
    return (
      <main className="landing">
        <nav className="topbar">
          {Brand({ as: "button" })}
          <div className="navRight">
            {ThemeToggle()}
            <button className="navJoin" onClick={() => { setModal("join"); }}>Unirme con un código</button>
          </div>
        </nav>
        <section className="detailView">
          <button className="backLink" onClick={goHome}>← Volver a las tierlists</button>
          <div className="detailHead">
            <div>
              <p className="eyebrow"><span />{active.visibility === "public" ? "PÚBLICA" : "PRIVADA"} · {active.items.length} ELEMENTOS</p>
              <h1>{active.name}</h1>
              {active.isOwner && <small className="ownerTag">Tu tierlist</small>}
            </div>
            <div className="detailActions">
              <button className="primaryButton" onClick={() => { setModal("createRoom"); }}>Crear sala <span>→</span></button>
              <button className="secondaryButton" onClick={() => openEditForm(active)}>{active.isOwner ? "Modificar" : "Hacer mi versión"}</button>
            </div>
          </div>
          <div className="itemsGrid">
            {active.items.map((item, i) => (
              <div className="itemCard" key={item.name + i}>
                {item.image ? <img className="itemThumb" src={item.image} alt="" /> : <span className="itemNum">{String(i + 1).padStart(2, "0")}</span>}
                <span>{item.name}</span>
              </div>
            ))}
          </div>
        </section>
        {modal === "join" && JoinModal()}
        {modal === "createRoom" && CreateRoomModal()}
      </main>
    );
  }

  // ---------- FORMULARIO CREAR / EDITAR TIERLIST ----------
  if (view === "form") {
    const updateItem = (i: number, patch: Partial<Item>) =>
      setForm((f) => ({ ...f, items: f.items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) }));
    const addItem = () => setForm((f) => ({ ...f, items: [...f.items, { name: "", image: null }] }));
    const removeItem = (i: number) => setForm((f) => ({ ...f, items: f.items.filter((_, idx) => idx !== i) }));
    const onPickImage = async (i: number, file: File | null) => {
      if (!file) return;
      try {
        const thumb = await fileToThumb(file);
        updateItem(i, { image: thumb });
      } catch {
        setError("No pudimos procesar esa imagen.");
      }
    };
    return (
      <main className="landing">
        <nav className="topbar">
          {Brand({ as: "button" })}
          <div className="navRight">{ThemeToggle()}</div>
        </nav>
        <section className="formView">
          <button className="backLink" onClick={() => (active ? setView("detail") : goHome())}>← Cancelar</button>
          <p className="eyebrow">{editingId ? "EDITAR TIERLIST" : "NUEVA TIERLIST"}</p>
          <h1>{editingId ? "Afina tu lista." : "Arma tu tierlist."}</h1>

          <label className="fieldLabel">Nombre de la tierlist</label>
          <input className="bigInput" value={form.name} maxLength={60} placeholder="Ej. Mejores animes de 2024" onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />

          <label className="fieldLabel">Visibilidad</label>
          <div className="visToggle">
            <button className={form.visibility === "public" ? "active" : ""} onClick={() => setForm({ ...form, visibility: "public" })}>
              <b>Pública</b><small>Cualquiera la ve y puede jugarla</small>
            </button>
            <button className={form.visibility === "private" ? "active" : ""} onClick={() => setForm({ ...form, visibility: "private" })}>
              <b>Privada</b><small>Solo tú la ves en tu portada</small>
            </button>
          </div>

          <label className="fieldLabel">Elementos a rankear <small>({form.items.length}) · la foto es opcional</small></label>
          <div className="itemsEditor">
            {form.items.map((item, i) => (
              <div className="itemRow" key={i}>
                <span className="itemNum">{String(i + 1).padStart(2, "0")}</span>
                <div className="imgCell">
                  <label className="imgPick" title="Añadir o cambiar foto">
                    {item.image ? <img src={item.image} alt="" /> : <span className="imgPlus">📷</span>}
                    <input type="file" accept="image/*" hidden onChange={(e) => onPickImage(i, e.target.files?.[0] ?? null)} />
                  </label>
                  {item.image && <button className="clearImg" onClick={() => updateItem(i, { image: null })} aria-label="Quitar foto">×</button>}
                </div>
                <input className="itemName" value={item.name} maxLength={80} placeholder={`Elemento ${i + 1}`} onChange={(e) => updateItem(i, { name: e.target.value })} />
                <button className="removeItem" onClick={() => removeItem(i)} disabled={form.items.length <= 2} aria-label="Quitar elemento">×</button>
              </div>
            ))}
          </div>
          <button className="addItem" onClick={addItem}>+ Añadir elemento</button>

          {error && <p className="error">{error}</p>}
          <button className="primaryButton wide" disabled={busy} onClick={saveTierlist}>{busy ? "Guardando…" : editingId ? "Guardar cambios" : "Crear tierlist"} <span>→</span></button>
        </section>
      </main>
    );
  }

  // ---------- PORTADA ----------
  return (
    <main className="landing">
      <nav className="topbar">
        {Brand({})}
        <div className="navRight">
          {ThemeToggle()}
          <button className="navJoin" onClick={() => setModal("join")}>Unirme a una sala</button>
        </div>
      </nav>
      <section className="hero">
        <div className="heroCopy">
          <p className="eyebrow"><span /> RANKEA · VOTA · GANA</p>
          <h1>Tus opiniones.<br />Una tier list.<br /><em>Cero peleas.*</em></h1>
          <p className="lead">Elige una tierlist, invita a tus amigos y decidid juntos qué merece estar arriba. Manda la mayoría. Cada acierto suma.</p>
          <div className="heroActions">
            <button className="primaryButton" onClick={openCreateForm}>Crear una tierlist <span>→</span></button>
            <button className="secondaryButton" onClick={() => setModal("join")}>Tengo un código</button>
          </div>
          <small className="disclaimer">*Las discusiones apasionadas sí están permitidas.</small>
        </div>
        <div className="heroVisual">
          <div className="orbitLabel one">S</div><div className="orbitLabel two">A</div><div className="orbitLabel three">B</div>
          <div className="demoCard">
            <p>VOTANDO AHORA</p><h3>¿En qué tier va?</h3>
            <div className="demoSubject"><span>進</span><strong>Shingeki no Kyojin</strong></div>
            <div className="demoRanks">{ranks.map((r) => <span key={r}>{r}</span>)}</div>
            <div className="demoFooter"><span>● ● ●</span><b>3/4 votaron</b></div>
          </div>
        </div>
      </section>

      <section className="gallery">
        <div className="galleryHead">
          <div><p className="eyebrow">ELIGE Y JUEGA</p><h2>Tierlists disponibles</h2></div>
          <button className="secondaryButton" onClick={openCreateForm}>+ Crear tierlist</button>
        </div>
        {tierlists.length === 0 ? (
          <div className="emptyGallery">Todavía no hay tierlists. <button className="linkButton" onClick={openCreateForm}>Crea la primera →</button></div>
        ) : (
          <div className="tlGrid">
            {tierlists.map((tl) => (
              <button className="tlCard" key={tl.id} onClick={() => openDetail(tl)}>
                <div className="tlCardTop">
                  <span className="tlBadge">{tl.visibility === "public" ? "Pública" : "Privada"}</span>
                  {tl.isOwner && <span className="tlMine">Tuya</span>}
                </div>
                <h3>{tl.name}</h3>
                {tl.items.some((it) => it.image) && (
                  <div className="tlThumbs">{tl.items.filter((it) => it.image).slice(0, 4).map((it, i) => <img key={i} src={it.image ?? ""} alt="" />)}</div>
                )}
                <p className="tlItems">{tl.items.slice(0, 4).map((it) => it.name).join(" · ")}{tl.items.length > 4 ? "…" : ""}</p>
                <div className="tlCardFoot"><span>{tl.items.length} elementos</span><span className="tlPlay">Jugar →</span></div>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="how">
        <p className="eyebrow">ASÍ DE SIMPLE</p>
        <h2>Una opinión a la vez.</h2>
        <div className="steps">
          <article><span>01</span><b>Elige una tierlist</b><p>Toma una de la galería o crea la tuya con los elementos que quieras.</p></article>
          <article><span>02</span><b>Vota contrarreloj</b><p>Tienes 5 segundos para elegir S, A, B, C o D. Sin ver al resto.</p></article>
          <article><span>03</span><b>Acércate a la mayoría</b><p>3 puntos si aciertas el rango más votado, 1 si quedas justo al lado.</p></article>
        </div>
      </section>

      {modal === "join" && JoinModal()}
      {modal === "createRoom" && CreateRoomModal()}
    </main>
  );
}
