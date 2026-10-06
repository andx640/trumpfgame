const fs = require("node:fs/promises");
const path = require("node:path");
const cards = require("../cards.json");

const USER_AGENT = "PitlaneTrumpf/2.0 (educational card game; image metadata updater)";
const OUTPUT_FILE = path.join(__dirname, "..", "card-images.json");
const ATTRIBUTION_FILE = path.join(__dirname, "..", "BILDQUELLEN.md");
const ARTICLE_TITLES = {
  "0008": "Porsche 911 (992)",
  "0011": "LaFerrari",
  "0012": "Ferrari F8",
  "0013": "Lamborghini Aventador",
  "0014": "Lamborghini Huracán",
  "0020": "Mercedes-AMG GT (C190)",
  "0022": "Audi R8 (Type 4S)",
  "0023": "Nissan GT-R",
  "0024": "Chevrolet Corvette (C8)",
  "0027": "Bugatti Chiron",
  "0029": "Pagani Zonda",
  "0030": "Bugatti Veyron",
  "0037": "Koenigsegg CCX",
  "0038": "Koenigsegg Jesko",
  "0039": "Koenigsegg Agera",
  "0061": "Aston Martin DBS Superleggera",
  "0063": "Ferrari Monza SP1 and SP2",
  "0064": "Ferrari 812 Superfast",
  "0065": "Ferrari 296",
  "0066": "Chevrolet Corvette (C8)",
  "0067": "Ferrari 488",
  "0069": "Honda NSX (second generation)",
  "0070": "Ferrari 458",
  "0073": "Ferrari 599",
  "0074": "Ferrari F12berlinetta",
  "0076": "Ferrari SF90 Stradale",
  "0080": "Lamborghini Huracán",
  "0081": "Lamborghini Huracán",
  "0083": "Lamborghini Aventador",
  "0085": "Lamborghini Gallardo",
  "0086": "Lamborghini Diablo",
  "0096": "Mercedes-AMG GT",
  "0097": "Porsche 911 GT2",
  "0098": "Porsche 911 GT1",
  "0099": "Gordon Murray Automotive T.50",
  "0103": "Pagani Huayra",
  "0104": "Pagani Zonda",
  "0106": "Saleen S7",
  "0109": "Chevrolet Corvette (C8)",
  "0112": "Mercedes-Benz SLS AMG",
  "0113": "Lykan HyperSport",
  "0118": "Bugatti EB 110",
  "0121": "Rimac Nevera",
  "0122": "Ruf CTR"
};
const FILE_OVERRIDES = {
  "0020": "Mercedes-AMG GT Black Series.jpg",
  "0032": "2022 Lotus Evija Silver.jpg",
  "0036": "2023 Mercedes AMG One 1.jpg"
};

// Gezielte Commons-Suche für Varianten: Suchbegriff und Muster, das im Dateinamen vorkommen muss.
const SEARCH_HINTS = {
  "0129": ["Bugatti La Voiture Noire", /voiture noire/],
  "0154": ["Porsche 911 Dakar", /dakar/],
  "0166": ["Audi RS6 Avant C8", /rs ?6(?!.*e-tron)/],
  "0180": ["Mercedes-Benz SLK 55 AMG", /slk ?55/],
  "0212": ["Porsche Cayman GT4 981", /cayman gt4/],
  "0272": ["Caterham 7", /caterham/],
  "0289": ["Porsche 993 Carrera", /993/],
  "0326": ["Mercedes-AMG GT C190", /amg gt(?!.*(63|43|53|badge|logo|emblem|interior|engine|motor|4-door))/],
  "0340": ["Chevrolet Corvette C6 Z06", /(c6|2006|2007|2008|2009|2010|2011|2012|2013).*z06|z06.*(c6|2006|2007|2008|2009|2010|2011|2012|2013)/],
  "0358": ["Nissan Z 2023", /(2023|2024|rz34|proto).*nissan z\b|nissan z\b.*(2023|2024|rz34|proto)/],
  "0034": ["Koenigsegg One:1", /one[ :_-]?1(?!.*(engine|motor|interior))/],
  "0050": ["McLaren 675LT", /675/],
  "0051": ["McLaren 600LT", /600 ?lt/],
  "0064": ["Ferrari 812 Competizione", /competizione/],
  "0067": ["Ferrari 488 Pista", /pista/],
  "0070": ["Ferrari 458 Speciale", /speciale/],
  "0073": ["Ferrari 599 GTO", /599 ?gto/],
  "0074": ["Ferrari F12tdf", /tdf/],
  "0086": ["Lamborghini Diablo GT", /diablo gt(?!r)/],
  "0094": ["Aston Martin Vanquish 2025", /vanquish(?!.*\bs\b).*202[4-6]|202[4-6].*vanquish(?!.*\bs\b)/],
  "0096": ["Mercedes-AMG GT R Pro", /r pro/],
  "0101": ["Zenvo TSR-S", /tsr/],
  "0109": ["Corvette E-Ray", /e-?ray/]
};
// Mit REFRESH_IDS=0001,0002 werden diese Karten neu gesucht, auch wenn schon ein Foto da ist.
const REFRESH_IDS = new Set(String(process.env.REFRESH_IDS || "").split(",").map((id) => id.trim()).filter(Boolean));

function apiUrl(host, parameters) {
  const url = new URL(`https://${host}/w/api.php`);
  Object.entries({ format: "json", origin: "*", ...parameters }).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return url;
}

async function query(host, parameters, attempt = 0) {
  const response = await fetch(apiUrl(host, parameters), { headers: { "User-Agent": USER_AGENT } });
  if (response.status === 429 && attempt < 8) {
    const retryAfter = Number(response.headers.get("retry-after")) || 5 * (attempt + 1);
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1_000));
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

  // Karten mit lokalem Foto bleiben unverändert, damit Bild und Urheberangabe zusammenpassen.
  const result = {};
  const usedFiles = new Set();
  for (const card of cards) {
    const existing = existingCatalog[card.c_id];
    if (existing?.localImage && !REFRESH_IDS.has(card.c_id)) {
      result[card.c_id] = existing;
      usedFiles.add(normalizedTitle(decodeURIComponent(String(existing.pageUrl || "").split("/wiki/")[1] || "")));
    }
  }

  async function imageInfoFor(fileTitle) {
    const data = await query("commons.wikimedia.org", {
      action: "query",
      prop: "imageinfo",
      titles: `File:${fileTitle}`,
      iiprop: "url|extmetadata",
      iiurlwidth: "1000"
    });
    return Object.values(data.query?.pages || {})[0]?.imageinfo?.[0] || null;
  }

  // Varianten teilen sich oft einen Wikipedia-Artikel; dann wird auf Commons nach einem eigenen Foto gesucht.
  async function searchFile(card) {
    const [searchTerm, mustMatch] = SEARCH_HINTS[card.c_id] || [card.name, null];
    const data = await query("commons.wikimedia.org", {
      action: "query",
      list: "search",
      srsearch: `${searchTerm} filetype:bitmap`,
      srnamespace: "6",
      srlimit: "20"
    });
    const hit = (data.query?.search || []).find(
      (entry) =>
        /\.(jpe?g|png)$/i.test(entry.title) &&
        !usedFiles.has(normalizedTitle(entry.title)) &&
        (!mustMatch || mustMatch.test(normalizedTitle(entry.title)))
    );
    return hit ? hit.title.replace(/^File:/i, "") : null;
  }

  for (const card of cards) {
    if (result[card.c_id]) {
      process.stdout.write(`• ${card.c_id} ${card.name} bereits lokal\n`);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const page = pageByCard.get(card.c_id);
    let fileTitle = FILE_OVERRIDES[card.c_id] || page?.pageimage;
    if (!fileTitle || usedFiles.has(normalizedTitle(fileTitle)) || SEARCH_HINTS[card.c_id]) {
      fileTitle = await searchFile(card);
    }
    const imageInfo = fileTitle ? await imageInfoFor(fileTitle) : null;
    const metadata = imageInfo?.extmetadata || {};
    const image = imageInfo?.thumburl || null;
    if (image) {
      usedFiles.add(normalizedTitle(fileTitle));
      result[card.c_id] = {
        image,
        pageUrl: imageInfo.descriptionurl,
        source: "Wikimedia Commons",
        author: cleanHtml(metadata.Artist?.value) || "siehe Bildquelle",
        license: cleanHtml(metadata.LicenseShortName?.value) || "siehe Bildquelle",
        licenseUrl: metadata.LicenseUrl?.value || imageInfo.descriptionurl
      };
      process.stdout.write(`✓ ${card.c_id} ${card.name} (${fileTitle})\n`);
      // Neues Foto für eine schon gespeicherte Karte: alte lokale Datei entfernen, damit sie neu geladen wird.
      if (existingCatalog[card.c_id]?.localImage && existingCatalog[card.c_id].pageUrl !== imageInfo.descriptionurl) {
        await fs.rm(path.join(__dirname, "..", existingCatalog[card.c_id].localImage), { force: true });
      } else if (existingCatalog[card.c_id]?.localImage) {
        result[card.c_id].localImage = existingCatalog[card.c_id].localImage;
      }
    } else if (existingCatalog[card.c_id]) {
      result[card.c_id] = existingCatalog[card.c_id];
      process.stdout.write(`• ${card.c_id} ${card.name}: kein passenderes Foto, altes bleibt\n`);
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
