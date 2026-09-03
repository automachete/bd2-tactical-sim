import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = resolve(repositoryRoot, "assets/character-icons/source");
const runtimeDirectory = resolve(repositoryRoot, "ui/assets/character-icons/64");
const qa32Directory = resolve(repositoryRoot, "assets/character-icons/qa/thumbnails/32");
const catalogPath = resolve(repositoryRoot, "data/generated/catalog.json");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function pngNames(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".png"))
    .toSorted();
}

function paeth(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function inspectPng(path) {
  const file = readFileSync(path);
  invariant(file.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${path}: invalid PNG signature`);
  let offset = 8;
  let header = null;
  const imageData = [];
  const metadataText = [];
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString("ascii", offset + 4, offset + 8);
    const data = file.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      imageData.push(data);
    } else if (type === "tEXt") {
      metadataText.push(data.toString("latin1"));
    } else if (type === "zTXt") {
      const separator = data.indexOf(0);
      invariant(separator >= 0 && data[separator + 1] === 0, `${path}: invalid zTXt chunk`);
      metadataText.push(data.subarray(0, separator).toString("latin1"));
      metadataText.push(inflateSync(data.subarray(separator + 2)).toString("utf8"));
    } else if (type === "iTXt") {
      const keywordEnd = data.indexOf(0);
      invariant(keywordEnd >= 0 && keywordEnd + 2 < data.length, `${path}: invalid iTXt chunk`);
      const compressed = data[keywordEnd + 1] === 1;
      const languageEnd = data.indexOf(0, keywordEnd + 3);
      const translatedEnd = data.indexOf(0, languageEnd + 1);
      invariant(languageEnd >= 0 && translatedEnd >= 0, `${path}: invalid iTXt fields`);
      metadataText.push(data.subarray(0, keywordEnd).toString("latin1"));
      const textData = data.subarray(translatedEnd + 1);
      metadataText.push((compressed ? inflateSync(textData) : textData).toString("utf8"));
    }
    offset += length + 12;
    if (type === "IEND") break;
  }
  invariant(header, `${path}: missing IHDR`);
  invariant(header.bitDepth === 8, `${path}: only 8-bit PNGs are supported`);
  invariant(header.colorType === 6 || header.colorType === 4, `${path}: PNG must contain an alpha channel`);
  invariant(header.interlace === 0, `${path}: interlaced PNGs are not supported`);
  const channels = header.colorType === 6 ? 4 : 2;
  const stride = header.width * channels;
  const compressed = Buffer.concat(imageData);
  const raw = inflateSync(compressed);
  invariant(raw.length === (stride + 1) * header.height, `${path}: unexpected decompressed size`);
  const pixels = Buffer.alloc(stride * header.height);
  let inputOffset = 0;
  for (let row = 0; row < header.height; row += 1) {
    const filter = raw[inputOffset++];
    invariant(filter <= 4, `${path}: unsupported PNG filter ${filter}`);
    for (let column = 0; column < stride; column += 1) {
      const input = raw[inputOffset++];
      const outputIndex = row * stride + column;
      const left = column >= channels ? pixels[outputIndex - channels] : 0;
      const above = row > 0 ? pixels[outputIndex - stride] : 0;
      const upperLeft = row > 0 && column >= channels ? pixels[outputIndex - stride - channels] : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
        : filter === 2 ? above
        : filter === 3 ? Math.floor((left + above) / 2)
        : paeth(left, above, upperLeft);
      pixels[outputIndex] = (input + predictor) & 0xff;
    }
  }
  const alphaOffset = channels - 1;
  let transparentPixels = 0;
  let opaquePixels = 0;
  let partialPixels = 0;
  for (let index = alphaOffset; index < pixels.length; index += channels) {
    const alpha = pixels[index];
    if (alpha === 0) transparentPixels += 1;
    else if (alpha === 255) opaquePixels += 1;
    else partialPixels += 1;
  }
  return {
    ...header,
    transparentPixels,
    opaquePixels,
    partialPixels,
    digest: createHash("sha256").update(file).digest("hex"),
    metadataText: metadataText.join("\n"),
  };
}

const sourceNames = pngNames(sourceDirectory);
const runtimeNames = pngNames(runtimeDirectory);
const qa32Names = pngNames(qa32Directory);
invariant(sourceNames.length === 61, `expected 61 source portraits, found ${sourceNames.length}`);
invariant(JSON.stringify(runtimeNames) === JSON.stringify(sourceNames), "64px runtime portrait names differ from source portraits");
invariant(JSON.stringify(qa32Names) === JSON.stringify(sourceNames), "32px QA portrait names differ from source portraits");

const runtimeDigests = new Set();
for (const name of sourceNames) {
  const source = inspectPng(resolve(sourceDirectory, name));
  const runtime = inspectPng(resolve(runtimeDirectory, name));
  const qa32 = inspectPng(resolve(qa32Directory, name));
  invariant(source.width > 64 && source.height > 64, `${name}: source must be larger than 64px in both dimensions`);
  invariant(runtime.width === 64 && runtime.height === 64, `${name}: runtime icon must be 64x64`);
  invariant(qa32.width === 32 && qa32.height === 32, `${name}: QA icon must be 32x32`);
  for (const [label, image] of [["source", source], ["runtime", runtime], ["QA", qa32]]) {
    invariant(image.transparentPixels > 0, `${name}: ${label} image has no transparent pixels`);
    invariant(image.opaquePixels + image.partialPixels > 0, `${name}: ${label} image is fully transparent`);
    invariant(
      !/(?:[a-z]:[\\/](?:users|documents and settings)[\\/]|\/(?:users|home)\/|desktop|appdata|file:\/\/|dwarf)/i.test(image.metadataText),
      `${name}: ${label} PNG metadata contains a local path or user identifier`,
    );
  }
  invariant(!runtimeDigests.has(runtime.digest), `${name}: duplicate 64px runtime image`);
  runtimeDigests.add(runtime.digest);
}

if (existsSync(catalogPath)) {
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const playable = Object.values(catalog.characters)
    .filter((character) => character.rarity === 5)
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const catalogNames = playable.map((character) => `${character.id}.png`).toSorted();
  invariant(JSON.stringify(catalogNames) === JSON.stringify(sourceNames), "portrait set differs from the current five-star catalog");
  const elements = new Set(playable.map((character) => character.element));
  invariant(
    JSON.stringify([...elements].toSorted()) === JSON.stringify(["DARK", "FIRE", "LIGHT", "WATER", "WIND"]),
    `five-star catalog must use exactly five elements, found ${[...elements].toSorted().join(", ")}`,
  );
}

console.log(JSON.stringify({ portraits: sourceNames.length, runtimeSize: 64, qaSize: 32, uniqueRuntimeImages: runtimeDigests.size, alphaValidated: true, metadataScanned: true }, null, 2));
