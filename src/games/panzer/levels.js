// Level von Panzerkiste: 22 × 16 Felder, eigene Entwürfe.
//   .  frei          #  Holzkiste (fest)        b  Pappkarton (Minen sprengen ihn)
//   o  Loch (Kugeln fliegen drüber, Panzer nicht)
//   P  du            W  Wachposten   S  Späher   J  Jäger   B  Blitz

export const LEVELS = [
  {
    name: "Erste Schritte",
    map: [
      "......................",
      "......................",
      "......................",
      "....##.......#........",
      "....##.......#....W...",
      ".............#........",
      ".............b........",
      "..P......o...b........",
      ".........o...b........",
      ".............b........",
      ".............#........",
      "....##.......#....S...",
      "....##.......#........",
      "......................",
      "......................",
      "......................"
    ]
  }
];
