const fs = require("node:fs/promises");
const path = require("node:path");

const CATALOG_FILE = path.join(__dirname, "..", "card-images.json");
const IMAGE_DIRECTORY = path.join(__dirname, "..", "cardimages", "cars");
const USER_AGENT = "PitlaneTrumpf/2.0 (educational card game; Wikimedia image cache)";

const EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
};

async function download(url, attempt = 0) {
  const cacheFriendlyUrl = url.replace(/\/\d+px-([^/?]+)(\?.*)?$/, "/960px-$1");
  const response = await fetch(cacheFriendlyUrl, { headers: { "User-Agent": USER_AGENT } });
  if (response.status === 429 && attempt < 3) {
    await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
    return download(cacheFriendlyUrl, attempt + 1);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";")[0];
  const extension = EXTENSIONS[contentType];
  if (!extension) throw new Error(`unbekannter Bildtyp ${contentType}`);
  return { bytes: Buffer.from(await response.arrayBuffer()), extension };
}

async function existingLocalImage(id) {
  for (const extension of Object.values(EXTENSIONS)) {
    const filename = `${id}.${extension}`;
    try {
      const stats = await fs.stat(path.join(IMAGE_DIRECTORY, filename));
      if (stats.size > 1_000) return `/cardimages/cars/${filename}`;
    } catch {
      // Die Datei wird anschließend geladen.
    }
  }
  return null;
}

async function main() {
  const catalog = JSON.parse(await fs.readFile(CATALOG_FILE, "utf8"));
  await fs.mkdir(IMAGE_DIRECTORY, { recursive: true });

  for (const [id, entry] of Object.entries(catalog)) {
    const existing = await existingLocalImage(id);
    if (existing) {
      entry.localImage = existing;
      process.stdout.write(`• ${id} bereits lokal\n`);
      continue;
    }

    try {
      const { bytes, extension } = await download(entry.image);
      const filename = `${id}.${extension}`;
      await fs.writeFile(path.join(IMAGE_DIRECTORY, filename), bytes);
      entry.localImage = `/cardimages/cars/${filename}`;
      process.stdout.write(`✓ ${id} ${(bytes.length / 1024).toFixed(0)} KB\n`);
      await new Promise((resolve) => setTimeout(resolve, 120));
    } catch (error) {
      process.stderr.write(`! ${id}: ${error.message}; Remote-Fallback bleibt aktiv\n`);
    }
  }

  await fs.writeFile(CATALOG_FILE, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  const localCount = Object.values(catalog).filter((entry) => entry.localImage).length;
  process.stdout.write(`\n${localCount}/${Object.keys(catalog).length} Bilder lokal verfügbar.\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
