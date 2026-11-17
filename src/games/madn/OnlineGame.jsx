import { useEffect, useState } from "react";
import { Button, Loading } from "../../ui";
import { unlockAudio } from "../../sound";
import { COLORS, currentSeat } from "./engine";
import { readName, useOnlineRoom } from "./online";
import { Confirm, Header, Result, Rules, Table, useGameSounds } from "./table";

// Online-Partie: Raum erstellen oder per Code beitreten, Lobby mit KI-Plätzen, dann spielen.
// Würfeln und Regeln prüft der Server; dieses Gerät spielt nur den eigenen Platz.

const MIN_ROLL_MS = 250;

export default function OnlineGame({ onBack, inviteCode = "" }) {
  const online = useOnlineRoom();
  const { room, state } = online;

  if (!room) return <Entry online={online} onBack={onBack} inviteCode={inviteCode} />;
  if (!state) {
    return (
      <>
        <Header onBack={onBack} />
        <div className="madn-wait"><Loading>Verbinde mit Raum {room} …</Loading></div>
      </>
    );
  }
  if (state.status === "lobby" || !state.game) return <Lobby online={online} onBack={onBack} />;
  return <OnlineTable online={online} onBack={onBack} />;
}

function ErrorNote({ online }) {
  if (!online.error) return null;
  return (
    <p className="madn-error" role="alert">
      {online.error}
      <button type="button" onClick={() => online.setError(null)} aria-label="Hinweis schließen">×</button>
    </p>
  );
}

function Entry({ online, onBack, inviteCode }) {
  const [name, setName] = useState(readName);
  const [code, setCode] = useState(inviteCode);
  const ready = name.trim().length > 0;

  return (
    <>
      <Header onBack={onBack} />
      <section className="madn-setup">
        <p className="madn-lead">Spiel mit Freunden auf ihren eigenen Geräten. Wer einen Raum erstellt, bekommt einen Code zum Teilen.</p>
        <label className="madn-field-label" htmlFor="madn-name">Dein Name</label>
        <input id="madn-name" className="madn-input" value={name} maxLength={16} placeholder="Name" onChange={(event) => setName(event.target.value)} />

        {inviteCode ? (
          <Button variant="primary" size="lg" block disabled={!ready || online.busy} onClick={() => { unlockAudio(); online.join(code, name.trim()); }}>
            Raum {inviteCode} beitreten
          </Button>
        ) : (
          <>
            <Button variant="primary" size="lg" block disabled={!ready || online.busy} onClick={() => { unlockAudio(); online.create(name.trim()); }}>
              Neuen Raum erstellen
            </Button>
            <div className="madn-divider"><span>oder mit Code beitreten</span></div>
            <form
              className="madn-join"
              onSubmit={(event) => {
                event.preventDefault();
                unlockAudio();
                online.join(code, name.trim());
              }}
            >
              <input
                className="madn-input madn-code-input"
                value={code}
                maxLength={8}
                placeholder="CODE"
                autoCapitalize="characters"
                autoComplete="off"
                aria-label="Raum-Code"
                onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
              />
              <Button type="submit" disabled={!ready || code.length < 4 || online.busy}>Beitreten</Button>
            </form>
          </>
        )}
        <ErrorNote online={online} />
        <Rules />
      </section>
    </>
  );
}

function inviteLink(room) {
  return `${window.location.origin}${window.location.pathname}#madn/${room}`;
}

function Lobby({ online, onBack }) {
  const { state, room } = online;
  const [copied, setCopied] = useState(false);
  const count = state.seats.filter(Boolean).length;

  const share = async () => {
    const link = inviteLink(room);
    try {
      if (navigator.share) {
        await navigator.share({ title: "Mensch ärgere dich nicht", text: `Spiel mit! Raum ${room}`, url: link });
        return;
      }
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // abgebrochen oder nicht erlaubt: Code steht ja groß da
    }
  };

  return (
    <>
      <Header onBack={onBack} />
      <section className="madn-setup">
        <div className="madn-room">
          <span>Raum-Code</span>
          <strong>{room}</strong>
          <Button size="sm" onClick={share}>{copied ? "Link kopiert" : "Einladen"}</Button>
        </div>
        <div className="madn-seats">
          {state.seats.map((seat, index) => {
            const you = index === state.selfSeat;
            return (
              <div className={`madn-seat madn-lobby-seat ${seat ? "" : "is-off"}`} key={COLORS[index].key}>
                <span className={`madn-dot is-${COLORS[index].key}`} aria-hidden="true" />
                <div className="madn-seat-head">
                  <span className="madn-seat-name">
                    <strong>{seat ? seat.name : COLORS[index].name}</strong>
                    <small>
                      {!seat ? "frei" : [you && "du", seat.host && "Gastgeber", seat.type === "ai" && "KI", seat.type === "human" && !seat.online && "offline"].filter(Boolean).join(" · ")}
                    </small>
                  </span>
                  {state.isHost && !seat && (
                    <Button size="sm" disabled={online.busy} onClick={() => online.act("addAi", { seat: index })}>+ KI</Button>
                  )}
                  {state.isHost && seat?.type === "ai" && (
                    <Button size="sm" variant="ghost" disabled={online.busy} onClick={() => online.act("removeAi", { seat: index })}>Entfernen</Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {state.isHost ? (
          <Button variant="primary" size="lg" block disabled={count < 2 || online.busy} onClick={() => { unlockAudio(); online.act("start"); }}>
            {count < 2 ? "Warte auf Mitspieler oder füge eine KI hinzu" : `Spiel starten · ${count} Spieler`}
          </Button>
        ) : (
          <p className="madn-lead madn-center-text">Warte, bis der Gastgeber das Spiel startet …</p>
        )}
        <Button variant="ghost" block onClick={online.leave}>Raum verlassen</Button>
        <ErrorNote online={online} />
      </section>
    </>
  );
}

function useSecondsLeft(deadline, serverNow) {
  const compute = () => (deadline ? Math.max(0, Math.ceil((deadline - serverNow()) / 1000)) : null);
  const [left, setLeft] = useState(compute);
  useEffect(() => {
    setLeft(compute());
    if (!deadline) return undefined;
    const timer = window.setInterval(() => setLeft(compute()), 500);
    return () => window.clearInterval(timer);
  }, [deadline]); // eslint-disable-line react-hooks/exhaustive-deps
  return left;
}

function OnlineTable({ online, onBack }) {
  const { state } = online;
  const game = state.game;
  const self = state.selfSeat;
  const [rolling, setRolling] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const over = game.phase === "over";
  const myTurn = !over && currentSeat(game) === self;
  const timeLeft = useSecondsLeft(myTurn ? state.deadline : null, online.serverNow);

  useGameSounds(game, (seat) => seat === self);

  const doRoll = async () => {
    setRolling(true);
    const started = Date.now();
    await online.act("roll");
    const rest = MIN_ROLL_MS - (Date.now() - started);
    if (rest > 0) await new Promise((resolve) => window.setTimeout(resolve, rest));
    setRolling(false);
  };
  const doMove = (piece) => online.act("move", { piece });

  const seatInfo = (seat) => ({ you: seat === self, online: state.seats[seat]?.type === "human" ? state.seats[seat].online : undefined });

  return (
    <>
      <Header onBack={onBack} title={`Raum ${online.room}`}>
        <Button size="sm" variant="ghost" onClick={() => (over ? online.leave() : setConfirmLeave(true))}>Verlassen</Button>
      </Header>
      {!online.connected && <p className="madn-error" role="alert">Verbindung unterbrochen – versuche es weiter …</p>}
      <Table
        game={game}
        controls={(seat) => seat === self}
        rolling={rolling}
        busy={online.busy && !rolling}
        onRoll={doRoll}
        onMove={doMove}
        seatInfo={seatInfo}
        timeLeft={timeLeft}
        viewSeat={self}
      />
      <div className="madn-game-note"><ErrorNote online={online} /></div>

      {over && (
        <Result game={game} seatInfo={seatInfo}>
          {state.isHost ? (
            <>
              <Button variant="primary" block disabled={online.busy} onClick={() => online.act("again")}>Nochmal spielen</Button>
              <Button block disabled={online.busy} onClick={() => online.act("lobby")}>Zurück in die Lobby</Button>
            </>
          ) : (
            <p className="madn-lead">Der Gastgeber entscheidet, ob es weitergeht.</p>
          )}
          <Button variant="ghost" block onClick={online.leave}>Raum verlassen</Button>
        </Result>
      )}
      {confirmLeave && (
        <Confirm
          title="Partie verlassen?"
          text="Eine KI übernimmt deine Figuren. Zurück kannst du dann nicht mehr."
          confirmLabel="Ja, verlassen"
          onConfirm={() => { setConfirmLeave(false); online.leave(); }}
          onCancel={() => setConfirmLeave(false)}
        />
      )}
    </>
  );
}
