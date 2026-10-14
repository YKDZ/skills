import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const vendor = join(root, "skills/ticket-graph/scripts/vendor");
const temporary = await mkdtemp(join(tmpdir(), "skills-generated-"));

try {
  for (const script of [
    "build-ticket-graph-config.ts",
    "build-ticket-graph-vendor.ts",
  ]) {
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts", script), temporary],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        `生成失败：${script}（退出码 ${result.status}，信号 ${result.signal}）。`,
      );
  }

  const generated = await readdir(temporary);
  const committed = (await readdir(vendor)).filter(
    (name) => !name.endsWith(".d.mts"),
  );
  const differences: string[] = [];
  for (const name of new Set([...generated, ...committed])) {
    if (!generated.includes(name) || !committed.includes(name)) {
      differences.push(name);
      continue;
    }
    const [expected, actual] = await Promise.all([
      readFile(join(temporary, name)),
      readFile(join(vendor, name)),
    ]);
    if (!expected.equals(actual)) differences.push(name);
  }
  if (differences.length) {
    throw new Error(
      `生成产物不一致：${differences.sort().join("、")}。请运行对应的 build:ticket-graph-config 或 build:ticket-graph-vendor 命令更新。`,
    );
  }
  console.log("生成产物一致。");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
