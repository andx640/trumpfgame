import { useEffect, useRef, useState } from "react";
import { playDice } from "../../sound";
import { BoardScene, webglAvailable } from "./scene3d";

/**
 * 3D-Brett. Würfelt jemand (game.lastRoll.n ändert sich), fliegt der Würfel übers Brett;
 * onSettled(n) meldet, wann er liegt. Ohne WebGL wird fallback angezeigt.
 */
export default function Board3D({ game, movable, viewSeat, waiting, canRoll, onPick, onRoll, onSettled, fallback }) {
  const hostRef = useRef(null);
  const sceneRef = useRef(null);
  const handlers = useRef({});
  handlers.current = { onPick, onRoll, onSettled };
  const [failed, setFailed] = useState(() => !webglAvailable());

  useEffect(() => {
    if (failed) return undefined;
    let scene;
    try {
      scene = new BoardScene(hostRef.current, {
        onPick: (index) => handlers.current.onPick?.(index),
        onRoll: () => handlers.current.onRoll?.(),
        onSettled: (n) => handlers.current.onSettled?.(n),
        onImpact: (strength) => playDice(strength)
      });
    } catch {
      setFailed(true);
      return undefined;
    }
    sceneRef.current = scene;
    return () => {
      sceneRef.current = null;
      scene.dispose();
    };
  }, [failed]);

  useEffect(() => {
    sceneRef.current?.sync({ game, movable, viewSeat, waiting, canRoll });
  });

  // ohne 3D gibt es keine Würfel-Animation: Wurf sofort als gelandet melden
  const rollN = game.lastRoll?.n ?? 0;
  useEffect(() => {
    if (failed) handlers.current.onSettled?.(rollN);
  }, [failed, rollN]);

  if (failed) return fallback;
  return <div className="madn-board3d" ref={hostRef} />;
}
