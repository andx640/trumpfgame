# Pitlane Trumpf

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

Die 128 echten Fahrzeugfotos stammen aus Wikimedia Commons und werden für einen zuverlässigen Spielbetrieb lokal zwischengespeichert. Urheber und Lizenzen stehen in `BILDQUELLEN.md`; zusätzlich verlinkt jede Karte ihre eigene Bildseite über `FOTO ↗`. Mit `npm run images:update` können Bildmetadaten und lokale Vorschaubilder erneut erzeugt werden.

## Qualitätssicherung

```bash
npm test
npm run build
npm audit
```

Die Tests decken Kartenverteilung, Kategorienregeln, Gleichstände, ungültige Züge und einen vollständigen Zwei-Client-Socket-Ablauf ab.
