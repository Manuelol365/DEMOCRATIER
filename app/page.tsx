"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Rank = "S" | "A" | "B" | "C" | "D";
type Player = { id: string; name: string; score: number; hasVoted: boolean };
type Result = { item: string; rank: Rank };
type Room = {
  code: string;
  theme: string;
  status: "lobby" | "voting" | "results";
  hostId: string;
  players: Player[];
  currentItem: string | null;
  round: number;
  totalRounds: number;
  results: Result[];
};

const themes = [
  { id: "anime", icon: "✦", title: "Anime esenciales", detail: "8 títulos · clásicos modernos", color: "violet" },
  { id: "ghibli", icon: "☁", title: "Películas de Ghibli", detail: "8 películas · pura magia", color: "mint" },
  { id: "games", icon: "◆", title: "Videojuegos inolvidables", detail: "8 juegos · multigeneración", color: "amber" },
];

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

export default function Home() {
  const [view, setView] = useState<"home" | "create" | "join" | "room">("home");
  const [theme, setTheme] = useState("anime");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [room, setRoom] = useState<Room | null>(null);
  const [playerId, setPlayerId] = useState("");
  const [selected, setSelected] = useState<Rank | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => setPlayerId(getPlayerId()), []);

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
      setView("room");
      return data as Room;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Algo salió mal.");
    } finally {
      setBusy(false);
    }
  }

  const me = room?.players.find((p) => p.id === playerId);
  const isHost = room?.hostId === playerId;
  const themeInfo = themes.find((item) => item.id === room?.theme);
  const voted = Boolean(me?.hasVoted);
  const waiting = room?.players.filter((p) => p.hasVoted).length ?? 0;
  const winner = useMemo(() => room?.players.slice().sort((a, b) => b.score - a.score)[0], [room]);

  if (view === "room" && room) {
    return (
      <main className="appShell">
        <nav className="topbar">
          <button className="brand" onClick={() => { setRoom(null); setView("home"); }} aria-label="Volver al inicio">
            <span className="brandMark">T</span><span>tierverse</span>
          </button>
          <div className="roomMeta">
            <span className="liveDot" /> Sala <strong>{room.code}</strong>
            <button className="copyButton" onClick={() => { navigator.clipboard.writeText(room.code); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
              {copied ? "Copiado" : "Copiar código"}
            </button>
          </div>
        </nav>

        {room.status === "lobby" && (
          <section className="roomLayout lobbyView">
            <div className="mainCard">
              <p className="eyebrow">SALA DE ESPERA</p>
              <h1>Todo listo para<br /><em>poner orden.</em></h1>
              <p className="lead">Comparte el código con tus amigos. La partida comenzará cuando el anfitrión esté listo.</p>
              <div className={`themePill ${themeInfo?.color}`}><span>{themeInfo?.icon}</span><div><small>TEMÁTICA</small><strong>{themeInfo?.title}</strong></div></div>
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
              <div><p className="eyebrow">RONDA {room.round + 1} DE {room.totalRounds}</p><h2>{themeInfo?.title}</h2></div>
              <div className="progress"><span style={{ width: `${((room.round + 1) / room.totalRounds) * 100}%` }} /></div>
            </div>
            <div className="subjectCard">
              <span className="subjectIndex">{String(room.round + 1).padStart(2, "0")}</span>
              <div className="subjectArt">{room.currentItem?.slice(0, 1)}</div>
              <div><small>¿DÓNDE LO PONDRÍAS?</small><h1>{room.currentItem}</h1><p>Tu voto es privado hasta que todos hayan elegido.</p></div>
            </div>
            <div className="rankGrid">
              {ranks.map((rank) => (
                <button key={rank} className={`rankButton rank${rank} ${selected === rank ? "selected" : ""}`} disabled={voted || busy}
                  onClick={() => { setSelected(rank); action({ action: "vote", code: room.code, rank }); }}>
                  <strong>{rank}</strong><span>{rankCopy[rank]}</span>
                </button>
              ))}
            </div>
            <div className="voteStatus">
              <div className="miniAvatars">{room.players.map((p, i) => <span key={p.id} className={`avatar a${i % 5} ${p.hasVoted ? "done" : ""}`}>{p.name[0]}</span>)}</div>
              <p>{voted ? "¡Voto enviado! " : ""}<strong>{waiting} de {room.players.length}</strong> jugadores han votado</p>
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
            <button className="secondaryButton" onClick={() => { setRoom(null); setView("home"); }}>Volver al inicio</button>
          </section>
        )}
      </main>
    );
  }

  return (
    <main className="landing">
      <nav className="topbar">
        <div className="brand"><span className="brandMark">T</span><span>tierverse</span></div>
        <button className="navJoin" onClick={() => setView("join")}>Unirme a una sala</button>
      </nav>
      <section className="hero">
        <div className="heroCopy">
          <p className="eyebrow"><span /> RANKEA · VOTA · GANA</p>
          <h1>Tus opiniones.<br />Una tier list.<br /><em>Cero peleas.*</em></h1>
          <p className="lead">Crea una sala, invita a tus amigos y decidid juntos qué merece estar arriba. Cada voto cuenta. Cada acierto suma.</p>
          <div className="heroActions">
            <button className="primaryButton" onClick={() => setView("create")}>Crear una sala <span>→</span></button>
            <button className="secondaryButton" onClick={() => setView("join")}>Tengo un código</button>
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
      <section className="how">
        <p className="eyebrow">ASÍ DE SIMPLE</p>
        <h2>Una opinión a la vez.</h2>
        <div className="steps">
          <article><span>01</span><b>Elige una temática</b><p>Anime, películas o videojuegos. La selección ya está preparada.</p></article>
          <article><span>02</span><b>Vota en secreto</b><p>Cada jugador elige S, A, B, C o D sin ver al resto.</p></article>
          <article><span>03</span><b>Acércate al consenso</b><p>100 puntos si aciertas la media, 50 si quedas al lado.</p></article>
        </div>
      </section>

      {(view === "create" || view === "join") && (
        <div className="modalBackdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) setView("home"); }}>
          <section className="modal">
            <button className="close" onClick={() => setView("home")} aria-label="Cerrar">×</button>
            <p className="eyebrow">{view === "create" ? "NUEVA PARTIDA" : "ENTRAR A UNA SALA"}</p>
            <h2>{view === "create" ? "Prepara la discusión." : "Únete al ranking."}</h2>
            <label>Tu nombre<input value={name} maxLength={18} onChange={(e) => setName(e.target.value)} placeholder="Ej. Manu" autoFocus /></label>
            {view === "create" ? (
              <>
                <label>Elige una temática</label>
                <div className="themeChoices">{themes.map((t) => <button key={t.id} className={theme === t.id ? "active" : ""} onClick={() => setTheme(t.id)}><span>{t.icon}</span><div><b>{t.title}</b><small>{t.detail}</small></div></button>)}</div>
                <button className="primaryButton wide" disabled={!name.trim() || busy} onClick={() => action({ action: "create", name, theme })}>{busy ? "Creando…" : "Crear sala"} <span>→</span></button>
              </>
            ) : (
              <>
                <label>Código de sala<input className="codeInput" value={code} maxLength={5} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCDE" /></label>
                <button className="primaryButton wide" disabled={!name.trim() || code.length < 5 || busy} onClick={() => action({ action: "join", name, code })}>{busy ? "Entrando…" : "Entrar a la sala"} <span>→</span></button>
              </>
            )}
            {error && <p className="error">{error}</p>}
          </section>
        </div>
      )}
    </main>
  );
}
