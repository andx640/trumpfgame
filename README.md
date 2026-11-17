# Andi Spiele

Eine Spielesammlung. Beim Start erscheint ein Hauptmenü, aus dem man ein Spiel auswählt:

- **Andi Trumpf** – serverautoritär geführtes Mehrspieler-Autoquartett (Details unten)
- **Panzerkiste** – Spielzeugpanzer-Action in der Holzkiste (eigene Level und Gegner), Steuerung per Tastatur/Maus oder Touch-Joystick.
- **Mensch ärgere dich nicht** – 2–6 Spieler (bis 4 auf dem klassischen Kreuz-Brett, mit Schwarz oder Lila auf dem Sechser-Brett), auf drei Arten:
  - *Gegen die KI* und *An einem Gerät* (reihum): läuft komplett im Browser, die Partie bleibt gespeichert
  - *Online*: Raum erstellen, Code oder Einladungslink (`#madn/CODE`) teilen; der Gastgeber kann freie Plätze mit KI füllen. Der Server würfelt und prüft jeden Zug, spielt KI-Plätze und übernimmt nach 30 Sekunden ohne Zug (bei Offline-Spielern schneller). Wer die Partie verlässt, wird durch eine KI ersetzt.

## Aufbau

```
src/App.jsx                 Hauptmenü und Umschalter (Adresse #trumpf, #madn)
src/games/registry.jsx      Liste aller Spiele
src/games/trumpf/           Andi Trumpf (Oberfläche; Spiel-API in api/)
src/games/madn/engine.js    Regeln von Mensch ärgere dich nicht, ohne Oberfläche
src/games/panzer/           Panzerkiste: engine.js (Spiellogik + KI), levels.js, scene.js (3D), PanzerApp.jsx
src/games/madn/MadnApp.jsx  Auswahl der Spielart
src/games/madn/table.jsx    Spieltisch: Status, Würfeln-Knopf, Spielerleiste (für alle Spielarten)
src/games/madn/scene3d.js   3D-Brett mit three.js: Figuren hüpfen Feld für Feld, Würfel rollt übers Brett
src/games/madn/Board3D.jsx  React-Hülle ums 3D-Brett (ohne WebGL: flaches SVG-Brett)
src/games/madn/LocalGame.jsx, OnlineGame.jsx, online.js
api/madn.php                Online-API (Räume, Würfeln, KI auf dem Server)
api/madn-engine.php         dieselben Regeln wie engine.js, für den Server
src/ui.jsx, ui.css          gemeinsame Bausteine und Design
```

**Neues Spiel hinzufügen:** Ordner `src/games/<id>/` anlegen, eine Komponente exportieren, die `{ onExit }` bekommt (führt zurück ins Menü), und einen Eintrag in `src/games/registry.jsx` ergänzen. Das Spiel wird erst beim Öffnen geladen. Spiellogik am besten wie bei `madn/engine.js` als reine Funktionen schreiben, dann lässt sie sich testen und später auch auf dem Server ausführen.

# Andi Trumpf

Ein serverautoritär geführtes Mehrspieler-Autoquartett für zwei bis vier Spieler. Das Frontend ist mit React und Vite umgesetzt, die Live-Synchronisation übernimmt Socket.IO.

## Lokal starten

```bash
npm install
npm run dev
```

Danach `http://localhost:5173` in zwei bis vier Browser-Tabs öffnen und je Tab mit einem Namen beitreten.

## Produktionsbetrieb

```bash
npm run build
npm start
```

Der Server liefert den Build anschließend standardmäßig unter `http://localhost:3000` aus. Über die Umgebungsvariable `PORT` kann ein anderer Port gesetzt werden.

## Spielablauf

- Der Host startet mit zwei bis vier Spielern.
- Der Host wählt 8, 16 oder 32 Karten pro Spieler.
- Aus dem 128-Karten-Deck werden exakt `Spielerzahl × Kartenzahl` unterschiedliche Karten gezogen und gleichmäßig verteilt.
- Jeder Client kann durch den vollständigen eigenen Stapel wischen; fremde Stapel bleiben privat.
- Nur die klar markierte Karte 1 ist in der aktuellen Runde spielbar.
- Das mobile Kartenkarussell nutzt exakt die Coverflow-Konfiguration der älteren Swiper-8.4.7-Version und unterstützt Touch und Maus.
- Die eigene oberste Karte liegt offen auf dem Tisch; fremde Karten bleiben zunächst verdeckt.
- Der aktive Spieler wählt innerhalb von 30 Sekunden eine Kategorie. Danach werden alle Tischkarten aufgedeckt.
- Bei Leistung, Hubraum, Höchstgeschwindigkeit, Drehmoment und Preis gewinnt der höchste Wert.
- Bei Beschleunigung und Gewicht gewinnt der niedrigste Wert.
- Bei Gleichstand wandern die Tischkarten in einen Pot. Der nächste eindeutige Gewinner erhält den gesamten Pot.
- Der Stichgewinner wählt in der nächsten Runde. Wer alle Karten besitzt, gewinnt die Partie.

Eine unterbrochene Spielsitzung wird im selben Browser-Tab automatisch wiederhergestellt. Antwortet ein aktiver Spieler nicht rechtzeitig, wählt der Server eine zufällige gültige Kategorie.

Das Deck besteht ausschließlich aus Supersport- und Hypersportwagen. Die echten Fahrzeugfotos stammen aus Wikimedia Commons und werden für einen zuverlässigen Spielbetrieb lokal zwischengespeichert. Urheber und Lizenzen stehen in `BILDQUELLEN.md`; zusätzlich verlinkt jede Karte ihre eigene Bildseite über `FOTO ↗`. Mit `npm run images:update` können Bildmetadaten und lokale Vorschaubilder erneut erzeugt werden; Karten ohne lokales Foto bekommen dabei automatisch eines.

## Qualitätssicherung

```bash
npm test
npm run build
npm audit
```

Die Tests decken Kartenverteilung, Kategorienregeln, Gleichstände, ungültige Züge und einen vollständigen Zwei-Client-Socket-Ablauf ab.
