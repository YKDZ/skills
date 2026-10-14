import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
  openSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(
  new URL("../skills/ticket-graph/scripts/ticket-graph.mts", import.meta.url),
);

function ticket(status = "open", dependencies: string[] = []) {
  return `---\nstatus: ${status}\nblocked_by: ${JSON.stringify(dependencies)}\n---\n正文\n`;
}
function fixture(t: TestContext, tickets: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "ticket-graph-batch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "issues");
  mkdirSync(directory);
  const config = join(root, "graph.json");
  writeFileSync(
    config,
    JSON.stringify({ tickets: "issues", completion: { values: ["done"] } }),
  );
  const path = (id: string) => join(directory, `${id}-任务.md`);
  for (const [id, text] of Object.entries(tickets))
    writeFileSync(path(id), text);
  return { root, config, directory, path, history: `${config}.history.jsonl` };
}
function run(config: string, ...args: string[]) {
  const result = spawnSync(
    process.execPath,
    [cli, "set-status", ...args, "--config", config],
    { encoding: "utf8" },
  );
  assert.ifError(result.error);
  return result;
}

void test("整批目标和候选内容全部通过预检后才写入", (t) => {
  for (const later of ["missing", "uneditable", "duplicate"] as const) {
    const f = fixture(t, {
      "01": ticket(),
      "02": later === "uneditable" ? "没有文件头\n" : ticket(),
    });
    if (later === "duplicate")
      writeFileSync(join(f.directory, "02-重复.md"), ticket());
    const before = readdirSync(f.directory).map((name) => [
      name,
      readFileSync(join(f.directory, name), "utf8"),
    ]);
    const result = run(
      f.config,
      "01",
      later === "missing" ? "99" : "02",
      "--status",
      "done",
    );
    assert.equal(result.status, 1, result.stderr);
    assert.equal(
      JSON.parse(result.stderr).data.error.code,
      later === "uneditable" ? "UNEDITABLE_FIELD" : "INVALID_TARGET",
    );
    assert.equal(existsSync(f.history), false);
    assert.deepEqual(
      readdirSync(f.directory).map((name) => [
        name,
        readFileSync(join(f.directory, name), "utf8"),
      ]),
      before,
    );
  }
});

void test("批量修改保留无关旧错和原文，无变化票不写入，依赖未完成也可设置状态", (t) => {
  const original =
    '---\r\nstatus: open # 当前\r\nblocked_by: ["02"]\r\nowner: 张三\r\n---\r\n正文\r\n';
  const f = fixture(t, {
    "01": original,
    "02": ticket("done"),
    "03": "旧票暂未修复\n",
  });
  const untouched = statSync(f.path("02")).mtimeMs;
  const result = run(f.config, "02", "01", "--status", "done");
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout).data;
  assert.equal(data.valid, false);
  assert.ok(
    data.issues.some((issue: { ticket: string }) => issue.ticket === "03"),
  );
  assert.deepEqual(
    data.results.map((row: { state: string }) => row.state),
    ["unchanged", "saved"],
  );
  assert.equal(statSync(f.path("02")).mtimeMs, untouched);
  assert.equal(
    readFileSync(f.path("01"), "utf8"),
    original.replace("status: open", 'status: "done"'),
  );
  assert.equal(readFileSync(f.history, "utf8").trim().split("\n").length, 1);
  const again = run(f.config, "01", "02", "--status", "done");
  assert.equal(again.status, 0, again.stderr);
  assert.ok(
    JSON.parse(again.stdout).data.results.every(
      (row: { changed: boolean }) => !row.changed,
    ),
  );
  assert.equal(readFileSync(f.history, "utf8").trim().split("\n").length, 1);
  const blocked = fixture(t, { "01": ticket("open", ["02"]), "02": ticket() });
  assert.equal(run(blocked.config, "01", "--status", "done").status, 0);
});

void test("首票已保存但历史失败时，后续票不执行，结果逐票保留实际效果", (t) => {
  const f = fixture(t, { "01": ticket(), "02": ticket() });
  mkdirSync(f.history);
  const result = run(f.config, "01", "02", "--status", "done");
  assert.equal(result.status, 1, result.stderr);
  const data = JSON.parse(result.stderr).data;
  assert.equal(data.error.code, "HISTORY_WRITE_FAILED");
  assert.deepEqual(
    data.effects.results.map(
      (row: {
        state: string;
        ticketSaved: boolean;
        historySaved: boolean | null;
      }) => [row.state, row.ticketSaved, row.historySaved],
    ),
    [
      ["failed", true, null],
      ["notExecuted", false, false],
    ],
  );
  assert.ok(readFileSync(f.path("01"), "utf8").includes('status: "done"'));
  assert.equal(readFileSync(f.path("02"), "utf8"), ticket());
});

void test(
  "后续票写入失败保留前票及其历史，并清理未保存的临时文件",
  { skip: process.platform !== "linux" },
  (t) => {
    const f = fixture(t, {
      "01": ticket(),
      "02": ticket() + "长正文".repeat(4000),
      "03": ticket(),
    });
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        'ulimit -f 2; trap "" XFSZ; exec "$@"',
        "batch-test",
        process.execPath,
        cli,
        "set-status",
        "01",
        "02",
        "03",
        "--status",
        "done",
        "--config",
        f.config,
      ],
      { encoding: "utf8" },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    const data = JSON.parse(result.stderr).data;
    assert.equal(data.error.code, "WRITE_FAILED");
    assert.deepEqual(
      data.effects.results.map(
        (row: {
          state: string;
          ticketSaved: boolean;
          historySaved: boolean;
        }) => [row.state, row.ticketSaved, row.historySaved],
      ),
      [
        ["saved", true, true],
        ["failed", false, false],
        ["notExecuted", false, false],
      ],
    );
    assert.ok(readFileSync(f.path("01"), "utf8").includes('status: "done"'));
    assert.equal(
      readFileSync(f.path("02"), "utf8"),
      ticket() + "长正文".repeat(4000),
    );
    assert.equal(readFileSync(f.path("03"), "utf8"), ticket());
    assert.equal(readFileSync(f.history, "utf8").trim().split("\n").length, 1);
    assert.deepEqual(readdirSync(f.directory).sort(), [
      "01-任务.md",
      "02-任务.md",
      "03-任务.md",
    ]);
  },
);

void test(
  "输出故障保留整批票及历史，不重复执行修改",
  { skip: process.platform !== "linux" },
  (t) => {
    const f = fixture(t, { "01": ticket(), "02": ticket() });
    const fd = openSync("/dev/full", "w");
    let result;
    try {
      result = spawnSync(
        process.execPath,
        [
          cli,
          "set-status",
          "01",
          "02",
          "--status",
          "done",
          "--config",
          f.config,
        ],
        { encoding: "utf8", stdio: ["ignore", fd, "pipe"] },
      );
    } finally {
      closeSync(fd);
    }
    assert.equal(result.status, 1, result.stderr);
    const data = JSON.parse(result.stderr);
    assert.equal(data.error.code, "OUTPUT_FAILED");
    assert.deepEqual(
      data.effects.results.map(
        (row: { ticketSaved: boolean; historySaved: boolean }) => [
          row.ticketSaved,
          row.historySaved,
        ],
      ),
      [
        [true, true],
        [true, true],
      ],
    );
    const events = readFileSync(f.history, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((event) => event.ticket),
      ["01", "02"],
    );
    for (const id of ["01", "02"])
      assert.ok(readFileSync(f.path(id), "utf8").includes('status: "done"'));
  },
);

void test("并行批量修改使用同一票集锁，每批读取和保存的状态连续一致", async (t) => {
  const ids = Array.from({ length: 30 }, (_, index) =>
    String(index + 1).padStart(2, "0"),
  );
  const f = fixture(t, Object.fromEntries(ids.map((id) => [id, ticket()])));
  const launch = (status: string) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [
          cli,
          "set-status",
          ...ids,
          "--status",
          status,
          "--config",
          f.config,
        ]);
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      },
    );
  const results = await Promise.all([launch("first"), launch("second")]);
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const events = readFileSync(f.history, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events.length, 60);
  assert.deepEqual(
    events.map((event) => event.ticket),
    [...ids, ...ids],
  );
  const first = events[0].after,
    second = events[30].after;
  assert.notEqual(first, second);
  assert.ok(
    events
      .slice(0, 30)
      .every((event) => event.before === "open" && event.after === first),
  );
  assert.ok(
    events
      .slice(30)
      .every((event) => event.before === first && event.after === second),
  );
  for (const id of ids)
    assert.ok(readFileSync(f.path(id), "utf8").includes(`status: "${second}"`));
});

void test("技能票头示例替换占位符后可以直接检查和批量修改", (t) => {
  const skill = readFileSync(
    new URL("../skills/ticket-graph/SKILL.md", import.meta.url),
    "utf8",
  );
  const example = /```yaml\n([\s\S]*?)```/u.exec(skill)?.[1];
  assert.ok(example);
  const f = fixture(t, {
    "01": example.replace("<项目约定的状态值>", "open") + "# 正文\n",
  });
  const checked = spawnSync(
    process.execPath,
    [cli, "check", "--config", f.config],
    { encoding: "utf8" },
  );
  assert.equal(checked.status, 0, checked.stderr);
  const updated = run(f.config, "01", "--status", "done");
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(JSON.parse(updated.stdout).data.results[0].before, "open");
});

void test("契约用法错误在访问文件前返回完整定位信息；帮助立即生效", (t) => {
  const f = fixture(t, { "01": ticket() });
  for (const args of [
    ["set-status", "01"],
    ["set-status", "01", "--status", " \t"],
    ["set-status", "--status", "done"],
    ["set-status", "01", "done"],
    ["set-status", "bad", "--status", "done"],
    ["set-deps", "01"],
    ["set-deps", "01", "02", "--clear"],
    ["list", "--filter", "ready"],
    ["list", "--unknown"],
  ]) {
    const result = spawnSync(
      process.execPath,
      [cli, ...args, "--config", f.config],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    const error = JSON.parse(result.stderr);
    assert.equal(error.schemaVersion, "1");
    assert.equal(error.kind, "usageFailure");
    assert.ok(error.issues.length);
    assert.equal(typeof error.usage, "string");
    assert.ok(error.helpArgv.includes("--help"));
    assert.equal(existsSync(f.history), false);
    assert.equal(readFileSync(f.path("01"), "utf8"), ticket());
  }
  const oldPosition = spawnSync(
    process.execPath,
    [cli, "--config", f.config, "check"],
    { encoding: "utf8" },
  );
  assert.equal(oldPosition.status, 2);
  assert.equal(JSON.parse(oldPosition.stderr).kind, "usageFailure");
  for (const args of [
    [],
    ["--help", "--unknown"],
    ["set-status", "--help", "--unknown"],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("--config"));
    assert.equal(result.stderr, "");
  }
});

void test("一次修改多张票，合并重复标识并按首次出现返回结果", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ticket-graph-batch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "issues"));
  const config = join(root, "graph.json");
  writeFileSync(
    config,
    JSON.stringify({ tickets: "issues", completion: { values: ["done"] } }),
  );
  for (const id of ["01", "02"])
    writeFileSync(
      join(root, "issues", `${id}-任务.md`),
      "---\nstatus: open\nblocked_by: []\n---\n正文\n",
    );
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "set-status",
      "02",
      "01",
      "02",
      "--status",
      "done",
      "--config",
      config,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.kind, "data");
  assert.deepEqual(
    output.data.results.map((row: { ticket: string }) => row.ticket),
    ["02", "01"],
  );
  assert.deepEqual(
    output.data.results.map(
      (row: { before: string; after: string; changed: boolean }) => [
        row.before,
        row.after,
        row.changed,
      ],
    ),
    [
      ["open", "done", true],
      ["open", "done", true],
    ],
  );
  const events = readFileSync(`${config}.history.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => event.ticket),
    ["02", "01"],
  );
  for (const id of ["01", "02"])
    assert.ok(
      readFileSync(join(root, "issues", `${id}-任务.md`), "utf8").includes(
        'status: "done"',
      ),
    );
});
