const fs = require("node:fs");
const path = require("node:path");

const deckFile = path.join(__dirname, "..", "cards.json");
const existingCards = JSON.parse(fs.readFileSync(deckFile, "utf8"));

// name, Leistung (PS), Hubraum (cm³), Vmax (km/h), Preis (EUR), 0-100 (s), Gewicht (kg), Drehmoment (Nm)
const additionalModels = [
  ["Porsche 911 GT3 RS", 525, 3996, 296, 248000, 3.2, 1450, 465],
  ["Ferrari 812 Superfast", 800, 6496, 340, 339000, 2.9, 1630, 718],
  ["Lamborghini Revuelto", 1015, 6498, 350, 500000, 2.5, 1772, 725],
  ["McLaren 765LT", 765, 3994, 330, 350000, 2.8, 1339, 800],
  ["Bugatti Mistral", 1600, 7993, 420, 5000000, 2.4, 1977, 1600],
  ["Koenigsegg Gemera", 2300, 4999, 400, 1700000, 1.9, 1880, 2750],
  ["Pagani Utopia", 864, 5980, 350, 2200000, 2.8, 1280, 1100],
  ["Aston Martin DBS 770 Ultimate", 770, 5204, 340, 357000, 3.4, 1845, 900],
  ["Mercedes-AMG SL 63", 585, 3982, 315, 188000, 3.6, 1970, 800],
  ["BMW M3 Competition", 530, 2993, 302, 105000, 3.5, 1780, 650],
  ["Audi RS 3", 400, 2480, 290, 66000, 3.8, 1570, 500],
  ["Porsche 718 Cayman GT4 RS", 500, 3996, 315, 155000, 3.4, 1415, 450],
  ["Chevrolet Corvette ZR1", 1079, 5500, 346, 200000, 2.5, 1665, 1123],
  ["Ford Mustang Dark Horse", 500, 5038, 263, 75000, 4.1, 1768, 567],
  ["Dodge Viper ACR", 654, 8382, 285, 150000, 3.5, 1530, 814],
  ["Acura NSX Type S", 608, 3493, 307, 170000, 2.9, 1725, 667],
  ["Honda Civic Type R", 329, 1996, 275, 58000, 5.4, 1429, 420],
  ["Toyota GR Yaris", 280, 1618, 230, 50000, 5.2, 1280, 390],
  ["Nissan Z Nismo", 426, 2997, 250, 70000, 4.3, 1680, 521],
  ["Mazda MX-5 RF", 184, 1998, 220, 39000, 6.8, 1115, 205],
  ["Alpine A110 R", 300, 1798, 285, 105000, 3.9, 1082, 340],
  ["Renault Mégane R.S. Trophy-R", 300, 1798, 262, 55000, 5.4, 1306, 400],
  ["Volkswagen Golf GTI Clubsport", 300, 1984, 267, 48000, 5.6, 1461, 400],
  ["Cupra Leon VZ", 300, 1984, 250, 50000, 5.7, 1490, 400],
  ["Hyundai Ioniq 5 N", 650, 0, 260, 74000, 3.4, 2200, 770],
  ["Kia Stinger GT", 366, 3342, 270, 58000, 4.9, 1855, 510],
  ["Genesis G70 3.3T", 370, 3342, 270, 55000, 4.7, 1730, 510],
  ["Polestar 1", 609, 1969, 250, 155000, 4.2, 2350, 1000],
  ["Lucid Air Sapphire", 1251, 0, 330, 250000, 1.9, 2430, 1939],
  ["Tesla Model 3 Performance", 460, 0, 262, 58000, 3.1, 1851, 660],
  ["Porsche Macan Turbo Electric", 639, 0, 260, 115000, 3.3, 2405, 1130],
  ["Audi RS e-tron GT Performance", 925, 0, 250, 160000, 2.5, 2395, 1027],
  ["BMW i5 M60", 601, 0, 230, 100000, 3.8, 2380, 820],
  ["Mercedes-AMG EQE 53", 687, 0, 240, 110000, 3.3, 2525, 1000],
  ["Rimac Concept One", 1224, 0, 355, 1000000, 2.5, 1850, 1600],
  ["Pininfarina Battista", 1900, 0, 350, 2200000, 1.9, 2200, 2340],
  ["Aspark Owl", 2012, 0, 413, 2900000, 1.7, 2000, 2000],
  ["Lotus Emeya R", 918, 0, 256, 150000, 2.8, 2565, 985],
  ["Nio EP9", 1360, 0, 313, 1400000, 2.7, 1735, 1480],
  ["MG Cyberster GT", 510, 0, 200, 70000, 3.2, 1985, 725],
  ["Caterham Seven 620R", 314, 1999, 250, 75000, 2.8, 610, 219],
  ["Ariel Atom 4", 324, 1998, 261, 80000, 2.8, 595, 420],
  ["BAC Mono R", 343, 2488, 274, 250000, 2.5, 555, 330],
  ["KTM X-Bow GT-XR", 500, 2480, 280, 285000, 3.4, 1250, 581],
  ["Morgan Plus Six", 340, 2998, 267, 100000, 4.2, 1145, 500],
  ["Bentley Continental GT Speed", 782, 3996, 335, 270000, 3.2, 2459, 1000],
  ["Rolls-Royce Spectre", 585, 0, 250, 390000, 4.5, 2890, 900],
  ["Maserati GranTurismo Trofeo", 550, 2992, 320, 225000, 3.5, 1795, 650],
  ["Alfa Romeo 4C", 240, 1742, 258, 70000, 4.5, 895, 350],
  ["Jaguar XE SV Project 8", 600, 5000, 322, 190000, 3.7, 1745, 700],
  ["Lexus LC 500", 477, 4969, 270, 130000, 4.7, 1931, 540],
  ["Subaru BRZ tS", 237, 2387, 226, 36000, 5.6, 1290, 250],
  ["Toyota GR86", 235, 2387, 226, 36000, 6.3, 1275, 250],
  ["Mitsubishi 3000GT VR-4", 286, 2972, 250, 60000, 5.7, 1710, 407],
  ["Mazda RX-7 Spirit R", 280, 1308, 250, 80000, 5.1, 1270, 314],
  ["Nissan Skyline GT-R R34", 280, 2568, 250, 130000, 5.2, 1560, 392],
  ["Honda NSX-R", 280, 3179, 280, 150000, 4.9, 1270, 304],
  ["BMW M1", 277, 3453, 262, 600000, 5.6, 1300, 330],
  ["Mercedes-Benz SLS AMG Black Series", 631, 6208, 315, 300000, 3.6, 1550, 635],
  ["Audi Quattro", 200, 2144, 220, 80000, 7.1, 1290, 285],
  ["Porsche Carrera GT", 612, 5733, 330, 1500000, 3.9, 1380, 590],
  ["Ferrari Enzo", 660, 5998, 350, 3000000, 3.6, 1365, 657],
  ["Lamborghini Murciélago SV", 670, 6496, 342, 500000, 3.2, 1565, 660],
  ["McLaren F1", 627, 6064, 386, 20000000, 3.2, 1138, 651],
  ["Bugatti EB110 Super Sport", 612, 3499, 351, 2000000, 3.3, 1418, 650],
  ["Jaguar XJ220", 550, 3498, 341, 600000, 3.6, 1470, 644],
  ["Ford Sierra RS500 Cosworth", 224, 1993, 248, 150000, 6.2, 1180, 277],
  ["Lancia Delta HF Integrale Evoluzione", 215, 1995, 220, 100000, 5.7, 1340, 314],
  ["Renault 5 Turbo", 160, 1397, 200, 100000, 6.9, 970, 221],
  ["Peugeot 205 Turbo 16", 200, 1775, 210, 200000, 6.0, 1145, 255],
  ["Volkswagen W12 Nardo", 600, 5998, 357, 3000000, 3.5, 1200, 620],
  ["Mercedes-Benz CLK GTR", 612, 6898, 344, 10000000, 3.8, 1440, 775],
  ["Porsche 959", 450, 2849, 317, 1500000, 3.7, 1450, 500],
  ["Ferrari F40", 478, 2936, 324, 2500000, 4.1, 1254, 577],
  ["Lamborghini Countach LPI 800-4", 814, 6498, 355, 2400000, 2.8, 1595, 720]
];

if (existingCards.length < 53) {
  throw new Error("Das Basisdeck ist unvollständig.");
}

const baseCards = existingCards.slice(0, 53);
const generatedCards = additionalModels.map((model, index) => {
  const [name, leistung, hubraum, hoechstgeschwindigkeit, preis, beschleunigung, gewicht, drehmoment] = model;
  return {
    c_id: String(index + 54).padStart(4, "0"),
    name,
    leistung,
    hubraum,
    hoechstgeschwindigkeit,
    preis,
    beschleunigung,
    gewicht,
    drehmoment
  };
});

const deck = existingCards.length > 128 ? existingCards : [...baseCards, ...generatedCards];
if (deck.length < 128 || new Set(deck.map((card) => card.c_id)).size !== deck.length || new Set(deck.map((card) => card.name)).size !== deck.length) {
  throw new Error("Das erzeugte Deck muss aus mindestens 128 eindeutigen Karten bestehen.");
}

fs.writeFileSync(deckFile, `${JSON.stringify(deck, null, 2)}\n`, "utf8");
process.stdout.write(`${deck.length} eindeutige Karten gespeichert.\n`);
