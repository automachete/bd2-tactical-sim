/**
 * Build the Japanese proper-name overlay without machine translation.
 *
 * The maintained Japanese costume index transcribes the in-game Japanese
 * character/costume labels.  Entries are joined to stable simulator IDs by
 * character and the source release order already preserved in costume_ids.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SOURCE_URL = "https://gamewith.jp/browndust2/524471";
const catalogPath = resolve(process.argv[2] ?? "../data/generated/catalog.json");
const outputPath = resolve(process.argv[3] ?? "../data/localization/ja-JP.json");

const characterNames = {
  Lathel: "ラテル", Justia: "ユースティア", Scheherazade: "シェラザード", Gray: "グレイ",
  Rou: "ルゥ", Olstein: "オルシュタイン", Sylvia: "シルヴィア", Rubia: "ルヴィア",
  Eclipse: "エクリプス", Teresse: "テレーゼ", Liatris: "リアトリス", Alec: "アレック",
  Seir: "セイル", Celia: "セリア", Anastasia: "アナスタシア", Lecliss: "レクリス",
  Rafina: "ラフィーナ", Elise: "エリーゼ", Helena: "ヘレナ", Eleaneer: "エレニール",
  Angelica: "アンジェリカ", Glacia: "グレイシア", Ventana: "ヴェンタナ", Diana: "ディアナ",
  Zenith: "ジェニス", Yuri: "ユリ", Dalvi: "キュウビ", Nartas: "ナルタス",
  Granhildr: "グランヒルト", Refithea: "レピテア", Loen: "ロエン", Roxy: "ロキシー",
  Eris: "エリス", Venaka: "ベナカ", Nebris: "ネブリス", SacredJustia: "神聖ユースティア",
  Levia: "レヴィア", Morpeah: "モルフェア", Michaela: "ミカエラ", Yomi: "詠",
  Yozakura: "夜桜", Hikage: "日影", Yumi: "雪泉", Luvencia: "ルベンシア",
  Liberta: "リベルタ", Blade: "ブレイド", Wilhelmina: "ウィルヘルミナ",
  GoblinSlayer: "ゴブリンスレイヤー", Priestess: "女神官", HighElfArcher: "妖精弓手",
  SwordMaiden: "剣の乙女", Olivier: "オリビエ", Sonya: "ソーニャ", Tyr: "ティル",
  Darian: "ダリアン", Granadair: "グラナデ", Palette: "パレット", Mamonir: "マモニル",
  Ikaruga: "斑鳩", Nekyndalia: "ネケンダリア", Aquila: "アクィラ",
};

const decodeHtml = value => value
  .replaceAll("&amp;", "&")
  .replaceAll("&quot;", '"')
  .replaceAll("&#039;", "'")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">");

const response = await fetch(SOURCE_URL, { headers: { "user-agent": "bd2-tactical-sim-localization-sync/0.1" } });
if (!response.ok) throw new Error(`${SOURCE_URL}: HTTP ${response.status}`);
const page = await response.text();
const byCharacter = new Map();
const entryPattern = /<li data-id="(\d+)" data-name="([^"]+)"[^>]*data-filter="([^"]*)"[^>]*>/g;
for (const match of page.matchAll(entryPattern)) {
  if (!match[3].split(/\s+/).includes("r5")) continue;
  const label = decodeHtml(match[2]);
  const parsed = label.match(/^(.+)\((.+)\)$/);
  if (!parsed) continue;
  const entry = { order: Number(match[1]), costume: parsed[1], character: parsed[2] };
  const rows = byCharacter.get(entry.character) ?? [];
  rows.push(entry);
  byCharacter.set(entry.character, rows);
}
for (const rows of byCharacter.values()) rows.sort((left, right) => left.order - right.order);

const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const characters = {};
const costumes = {};
for (const [characterId, japaneseName] of Object.entries(characterNames)) {
  const character = catalog.characters[characterId];
  if (!character) throw new Error(`catalog character is missing: ${characterId}`);
  const rows = byCharacter.get(japaneseName) ?? [];
  if (rows.length !== character.costume_ids.length) {
    throw new Error(`${characterId}/${japaneseName}: source=${rows.length}, catalog=${character.costume_ids.length}`);
  }
  characters[characterId] = japaneseName;
  character.costume_ids.forEach((costumeId, index) => { costumes[costumeId] = rows[index].costume; });
}

const observedAt = new Date().toISOString();
const result = {
  locale: "ja-JP",
  provenance: {
    source_url: SOURCE_URL,
    observed_at: observedAt,
    source_digest: createHash("sha256").update(page).digest("hex"),
    method: "Exact transcription joined by character and preserved costume release order; no machine translation",
  },
  characters,
  costumes,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: outputPath, characters: Object.keys(characters).length, costumes: Object.keys(costumes).length }, null, 2));
