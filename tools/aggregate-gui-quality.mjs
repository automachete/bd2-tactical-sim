import { readFile, writeFile } from "node:fs/promises";

const [output, ...inputs] = process.argv.slice(2);
if (!output || inputs.length === 0) {
  throw new Error("usage: node aggregate-gui-quality.mjs OUTPUT INPUT...");
}
const shards = await Promise.all(inputs.map(async input => {
  const report = JSON.parse(await readFile(input, "utf8"));
  if (report.schema !== "bd2-gui-model-quality-v1" || report.status !== "ok") {
    throw new Error(`${input} is not a successful GUI quality report`);
  }
  return report;
}));
const ranges = shards
  .map(report => ({ start: report.sequenceOffset, end: report.sequenceOffset + report.sequences }))
  .sort((left, right) => left.start - right.start);
for (let index = 0; index < ranges.length; index += 1) {
  const expectedStart = index === 0 ? 0 : ranges[index - 1].end;
  if (ranges[index].start !== expectedStart) {
    throw new Error(`GUI quality shards overlap or leave a gap at sequence ${expectedStart}`);
  }
}
const report = {
  schema: "bd2-gui-model-quality-v1",
  sequences: shards.reduce((sum, shard) => sum + shard.sequences, 0),
  completedTurns: shards.reduce((sum, shard) => sum + shard.completedTurns, 0),
  modes: [...new Set(shards.flatMap(shard => shard.modes))],
  shards: ranges.length,
  failures: 0,
  status: "ok",
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report));
