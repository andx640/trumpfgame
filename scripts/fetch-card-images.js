const fs = require("node:fs/promises");
const path = require("node:path");
const cards = require("../cards.json");

const USER_AGENT = "PitlaneTrumpf/2.0 (educational card game; image metadata updater)";
const OUTPUT_FILE = path.join(__dirname, "..", "card-images.json");
const ATTRIBUTION_FILE = path.join(__dirname, "..", "BILDQUELLEN.md");
const ARTICLE_TITLES = {
  "0007": "Tesla Model S",
  "0008": "Porsche 911 (992)",
  "0011": "LaFerrari",
  "0012": "Ferrari F8",
  "0013": "Lamborghini Aventador",
  "0014": "Lamborghini Huracán",
  "0020": "Mercedes-AMG GT (C190)",
  "0021": "BMW M5 (F90)",
  "0022": "Audi R8 (Type 4S)",
  "0023": "Nissan GT-R",
  "0024": "Chevrolet Corvette (C8)",
  "0025": "Chevrolet Camaro (sixth generation)",
  "0026": "Shelby Mustang",
  "0027": "Dodge Challenger (2008)",
  "0029": "Pagani Zonda",
  "0030": "Alfa Romeo Giulia (952)",
  "0033": "Lotus Emira",
  "0037": "Volkswagen Golf Mk8",
  "0038": "Audi RS 6",
  "0039": "Porsche Taycan",
  "0040": "Tesla Roadster (second generation)",
  "0042": "Jaguar F-Type",
  "0044": "Subaru Impreza WRX STI",
  "0045": "Mitsubishi Lancer Evolution X",
  "0046": "Peugeot 508",
  "0047": "Cupra Formentor",
  "0048": "Hyundai i30 N",
  "0049": "Kia EV6",
  "0050": "Polestar 2",
  "0051": "BMW i4",
  "0052": "Lucid Air",
  "0053": "Volkswagen I.D. R",
  "0061": "Aston Martin DBS Superleggera",
  "0062": "Mercedes-Benz SL (R232)",
  "0063": "BMW M3",
  "0065": "Porsche 718 Cayman GT4",
  "0066": "Chevrolet Corvette (C8)",
  "0067": "Ford Mustang (seventh generation)",
  "0069": "Honda NSX (second generation)",
  "0075": "Renault Mégane RS",
  "0076": "Volkswagen Golf Mk8",
  "0077": "Cupra León",
  "0078": "Hyundai Ioniq 5",
  "0080": "Genesis G70",
  "0083": "Tesla Model 3",
  "0084": "Porsche Macan",
  "0085": "Audi e-tron GT",
  "0086": "BMW 5 Series (G60)",
  "0087": "Mercedes-Benz EQE",
  "0091": "Lotus Emeya",
  "0093": "MG Cyberster",
  "0094": "Caterham 7",
  "0095": "Ariel Atom",
  "0096": "BAC Mono",
  "0097": "KTM X-Bow",
  "0099": "Bentley Continental GT",
  "0101": "Maserati GranTurismo",
  "0103": "Jaguar XE",
  "0105": "Subaru BRZ",
  "0107": "Mitsubishi 3000GT",
  "0108": "Mazda RX-7",
  "0109": "Nissan Skyline GT-R",
  "0110": "Honda NSX",
  "0112": "Mercedes-Benz SLS AMG",
  "0118": "Bugatti EB 110"
};
const FILE_OVERRIDES = {
  "0020": "Mercedes-AMG GT Black Series.jpg",
  "0021": "BMW M5 CS.jpg",
  "0032": "2022 Lotus Evija Silver.jpg",
  "0036": "2023 Mercedes AMG One 1.jpg",
  "0096": "BAC Mono R 2.jpg"
};

function apiUrl(host, parameters) {
  const url = new URL(`https://${host}/w/api.php`);
  Object.entries({ format: "json", origin: "*", ...parameters }).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return url;
}

async function query(host, parameters, attempt = 0) {
  const response = await fetch(apiUrl(host, parameters), { headers: { "User-Agent": USER_AGENT } });
  if (response.status === 429 && attempt < 4) {
    await new Promise((resolve) => setTimeout(resolve, 1_500 * (attempt + 1)));
    return query(host, parameters, attempt + 1);
  }
  if (!response.ok) throw new Error(`${host} antwortet mit HTTP ${response.status}`);
  return response.json();
}

function cleanHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function chunks(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, index * size + size)
  );
}

function normalizedTitle(value) {
  return String(value || "").replace(/^File:/i, "").replace(/_/g, " ").trim().toLowerCase();
}

function resolvedPages(data, requestedTitles) {
  const redirects = new Map();
  for (const entry of [...(data.query?.normalized || []), ...(data.query?.redirects || [])]) {
    redirects.set(normalizedTitle(entry.from), entry.to);
  }
  const pages = new Map(
    Object.values(data.query?.pages || {}).map((page) => [normalizedTitle(page.title), page])
  );
  const result = new Map();
  for (const requestedTitle of requestedTitles) {
    let title = requestedTitle;
    for (let index = 0; index < 4 && redirects.has(normalizedTitle(title)); index += 1) {
      title = redirects.get(normalizedTitle(title));
    }
    result.set(requestedTitle, pages.get(normalizedTitle(title)) || null);
  }
  return result;
}

async function main() {
  let existingCatalog = {};
  try {
    existingCatalog = JSON.parse(await fs.readFile(OUTPUT_FILE, "utf8"));
  } catch {
    // Beim ersten Lauf existiert noch kein Katalog.
  }

  const pageByCard = new Map();
  for (const group of chunks(cards, 40)) {
    const titles = group.map((card) => ARTICLE_TITLES[card.c_id] || card.name);
    const data = await query("en.wikipedia.org", {
      action: "query",
      prop: "pageimages|info",
      titles: titles.join("|"),
      redirects: "1",
      piprop: "thumbnail|name",
      pithumbsize: "1000",
      inprop: "url"
    });
    const pageByTitle = resolvedPages(data, titles);
    group.forEach((card, index) => pageByCard.set(card.c_id, pageByTitle.get(titles[index])));
  }

  const imageTitles = [...new Set(
    cards
      .map((card) => FILE_OVERRIDES[card.c_id] || pageByCard.get(card.c_id)?.pageimage)
      .filter(Boolean)
      .map((title) => `File:${title}`)
  )];
  const imageInfoByTitle = new Map();
  for (const group of chunks(imageTitles, 40)) {
    const data = await query("commons.wikimedia.org", {
      action: "query",
      prop: "imageinfo",
      titles: group.join("|"),
      iiprop: "url|extmetadata",
      iiurlwidth: "1000"
    });
    Object.values(data.query?.pages || {}).forEach((page) => {
      imageInfoByTitle.set(normalizedTitle(page.title), page.imageinfo?.[0] || null);
    });
  }

  const result = {};
  for (const card of cards) {
    const page = pageByCard.get(card.c_id);
    const fileTitle = FILE_OVERRIDES[card.c_id] || page?.pageimage;
    const imageInfo = imageInfoByTitle.get(normalizedTitle(fileTitle));
    const metadata = imageInfo?.extmetadata || {};
    const image = imageInfo?.thumburl || page?.thumbnail?.source || null;
    if (image) {
      result[card.c_id] = {
        image,
        ...(existingCatalog[card.c_id]?.localImage
          ? { localImage: existingCatalog[card.c_id].localImage }
          : {}),
        pageUrl: imageInfo?.descriptionurl || page.fullurl,
        source: "Wikimedia Commons",
        author: cleanHtml(metadata.Artist?.value) || "siehe Bildquelle",
        license: cleanHtml(metadata.LicenseShortName?.value) || "siehe Bildquelle",
        licenseUrl: metadata.LicenseUrl?.value || imageInfo?.descriptionurl || page.fullurl
      };
      process.stdout.write(`✓ ${card.c_id} ${card.name}\n`);
    } else {
      process.stdout.write(`– ${card.c_id} ${card.name}: kein Bild gefunden\n`);
    }
  }
  await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  const rows = cards.map((card) => {
    const entry = result[card.c_id];
    if (!entry) return `| ${card.c_id} | ${card.name} | – | – |`;
    const author = entry.author.replace(/\|/g, "\\|");
    return `| ${card.c_id} | ${card.name} | [${author}](${entry.pageUrl}) | [${entry.license}](${entry.licenseUrl}) |`;
  });
  const attribution = [
    "# Bildquellen",
    "",
    "Die Fahrzeugfotos werden als skalierte Vorschaubilder von Wikimedia Commons geladen. Auf jeder Karte führt `FOTO ↗` direkt zur jeweiligen Beschreibungs- und Lizenzseite.",
    "",
    "| Karte | Fahrzeug | Urheber und Quelle | Lizenz |",
    "| --- | --- | --- | --- |",
    ...rows,
    ""
  ].join("\n");
  await fs.writeFile(ATTRIBUTION_FILE, attribution, "utf8");
  process.stdout.write(`\n${Object.keys(result).length}/${cards.length} Bildquellen gespeichert.\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
