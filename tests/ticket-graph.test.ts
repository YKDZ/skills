import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  openSync,
  closeSync,
  chmodSync,
  cpSync,
  renameSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { Completion } from "../skills/ticket-graph/scripts/types.ts";
import { success, failure } from "./cli-output.ts";

const cli = fileURLToPath(
  new URL("../skills/ticket-graph/scripts/ticket-graph.mts", import.meta.url),
);
function fixture(
  t: TestContext,
  tickets: Record<string, string>,
  completion: Completion = { values: ["resolved"] },
) {
  const root = mkdtempSync(join(tmpdir(), "ticket-graph-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "issues"));
  const config = join(root, "ticket-graph.json");
  writeFileSync(config, JSON.stringify({ tickets: "issues", completion }));
  for (const [id, text] of Object.entries(tickets))
    writeFileSync(join(root, "issues", `${id}-ticket.md`), text);
  return {
    root,
    config,
    path: (id: string) => join(root, "issues", `${id}-ticket.md`),
    history: `${config}.history.jsonl`,
  };
}
function ticket(status = "open", deps: string[] = []) {
  return `---\nstatus: ${status}\nblocked_by: ${JSON.stringify(deps)}\n---\n# 任务\n\n正文。\n`;
}
function run(f: { config: string }, ...args: string[]) {
  const result = spawnSync(
    process.execPath,
    [cli, args[0]!, "--config", f.config, ...args.slice(1)],
    { encoding: "utf8", cwd: tmpdir() },
  );
  assert.ifError(result.error);
  return {
    ...result,
    data: success(result.stdout || "{}"),
    error: failure(result.stderr || "{}"),
  };
}
function runAsync(f: { config: string }, ...args: string[]) {
  return new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
    data: ReturnType<typeof success>;
    error: ReturnType<typeof failure>;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cli, args[0]!, "--config", f.config, ...args.slice(1)],
      { cwd: tmpdir() },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) =>
      resolve({
        status,
        stdout,
        stderr,
        data: success(stdout || "{}"),
        error: failure(stderr || "{}"),
      }),
    );
  });
}

void test("按配置计算未完成票的直接前置，查询不写文件", (t) => {
  const f = fixture(t, {
    "01": ticket("resolved"),
    "02": ticket("open", ["01"]),
    "03": ticket("open", ["02"]),
  });
  const result = run(f, "list", "--filter", "unblocked");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.data.tickets.map((item) => item.id),
    ["02"],
  );
  assert.equal(result.data.total, 3);
  assert.deepEqual(result.data.tickets[0]!.blocked_by, ["01"]);
  assert.equal(result.stderr, "");
  assert.equal(existsSync(f.history), false);
  assert.equal(readFileSync(f.path("02"), "utf8"), ticket("open", ["01"]));
});

void test("帮助不要求配置；无效用法和配置返回可定位的结构化错误", (t) => {
  for (const command of [
    "",
    "init",
    "check",
    "list",
    "set-status",
    "set-deps",
    "history",
  ]) {
    const result = spawnSync(
      process.execPath,
      [cli, ...(command ? [command] : []), "--help"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("--config"));
    assert.equal(result.stderr, "");
  }
  const f = fixture(t, {});
  const missing = run(f, "set-deps", "01");
  assert.equal(missing.status, 2);
  assert.equal(missing.error.kind, "usageFailure");
  writeFileSync(
    f.config,
    JSON.stringify({ tickets: "issues", completion: { values: [] } }),
  );
  const invalid = run(f, "list");
  assert.equal(invalid.status, 1);
  assert.equal(invalid.error.error.code, "INVALID_CONFIG");
  assert.equal(invalid.error.error.file, f.config);
});

void test("修改完成字段保留其余原文，重复设置不重写或追加历史", (t) => {
  const before =
    '---\r\n# 注释\r\nstatus: open # 仍需实施\r\nblocked_by: []\r\nextra: "原样保留"\r\n---\r\n正文：status: open\r\n';
  const f = fixture(t, { "01": before }, { values: ["shipped", "resolved"] });
  const result = run(f, "set-status", "01", "--status", "shipped");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.data.results[0]!.changed, true);
  assert.equal(result.data.results[0]!.field, "status");
  assert.equal(result.data.results[0]!.before, "open");
  assert.equal(result.data.results[0]!.after, "shipped");
  assert.equal(
    readFileSync(f.path("01"), "utf8"),
    before.replace("status: open #", 'status: "shipped" #'),
  );
  const history = readFileSync(f.history, "utf8");
  const event = JSON.parse(history);
  assert.equal(event.ticket, "01");
  assert.equal(event.field, "status");
  assert.equal(event.before, "open");
  assert.equal(event.after, "shipped");
  assert.ok(Number.isFinite(Date.parse(event.time)));
  const again = run(f, "set-status", "01", "--status", "shipped");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.data.results[0]!.changed, false);
  assert.equal(readFileSync(f.history, "utf8"), history);
  assert.equal(run(f, "list").data.tickets[0]!.delivery_complete, true);
});

void test("替换和显式清空依赖留下可筛选的历史，损坏历史不影响当前查询", (t) => {
  const f = fixture(t, {
    "01": ticket("resolved"),
    "02": ticket(),
    "03": ticket(),
  });
  assert.deepEqual(run(f, "history").data.events, []);
  assert.equal(run(f, "set-deps", "03", "01", "02").status, 0);
  assert.deepEqual(
    run(f, "list", "--filter", "blocked").data.tickets[0]!
      .blocked_by_unfinished,
    ["02"],
  );
  const cleared = run(f, "set-deps", "03", "--clear");
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.deepEqual(cleared.data.before, ["01", "02"]);
  assert.deepEqual(cleared.data.after, []);
  assert.equal(run(f, "set-status", "02", "--status", "resolved").status, 0);
  const history = run(f, "history", "--ticket", "03");
  assert.equal(history.status, 0, history.stderr);
  assert.equal(history.data.events.length, 2);
  assert.deepEqual(
    history.data.events.map((event) => event.after),
    [["01", "02"], []],
  );
  assert.deepEqual(run(f, "history", "--ticket", "99").data.events, []);
  assert.equal(run(f, "history").data.events.length, 3);
  writeFileSync(f.history, "损坏的记录\n");
  const broken = run(f, "history");
  assert.equal(broken.status, 1);
  assert.equal(broken.error.error.code, "INVALID_HISTORY");
  assert.equal(broken.error.error.line, 1);
  assert.equal(run(f, "list").status, 0);
});

void test("同一票集并行修改依赖不会共同形成新环", async (t) => {
  for (let round = 0; round < 6; round++) {
    const tickets: Record<string, string> = { "01": ticket(), "02": ticket() };
    for (let index = 10; index < 80; index++) tickets[String(index)] = ticket();
    const f = fixture(t, tickets);
    const results = await Promise.all([
      runAsync(f, "set-deps", "01", "02"),
      runAsync(f, "set-deps", "02", "01"),
    ]);
    assert.deepEqual(
      results
        .map((result) => result.status)
        .sort((a, b) => (a ?? -1) - (b ?? -1)),
      [0, 1],
      JSON.stringify(results),
    );
    assert.equal(run(f, "check").status, 0);
    const events = run(f, "history").data.events;
    assert.equal(events.length, 1);
    assert.equal(
      events[0]!.ticket,
      results.find((result) => result.status === 0)!.data.ticket,
    );
  }
});

void test("票已保存而历史失败时报告部分结果", (t) => {
  const f = fixture(t, { "01": ticket() });
  mkdirSync(f.history);
  const partial = run(f, "set-status", "01", "--status", "resolved");
  assert.equal(partial.status, 1);
  assert.equal(partial.error.error.code, "HISTORY_WRITE_FAILED");
  assert.equal(partial.error.effects.results![0]!.ticketSaved, true);
  assert.notEqual(partial.error.effects.results![0]!.historySaved, true);
  assert.equal(partial.error.effects.results![0]!.after, "resolved");
  assert.equal(run(f, "list").data.tickets[0]!.delivery_complete, true);
});

void test(
  "输出故障不抹掉已写入的票及历史",
  { skip: process.platform !== "linux" },
  (t) => {
    assert.ok(existsSync("/dev/full"), "Linux 验收需要 /dev/full。");
    const g = fixture(t, { "01": ticket() });
    const full = openSync("/dev/full", "w");
    let result;
    try {
      result = spawnSync(
        process.execPath,
        [cli, "set-status", "--config", g.config, "01", "--status", "resolved"],
        { stdio: ["ignore", full, "pipe"], encoding: "utf8" },
      );
    } finally {
      closeSync(full);
    }
    assert.equal(result.status, 1);
    const error = failure(result.stderr);
    assert.equal(error.error.code, "OUTPUT_FAILED");
    assert.equal(error.effects.results![0]!.ticketSaved, true);
    assert.equal(error.effects.results![0]!.historySaved, true);
    assert.equal(run(g, "list").data.tickets[0]!.delivery_complete, true);
    assert.equal(run(g, "history").data.events.length, 1);
  },
);

void test("新增依赖不能把读取失败当作无依赖，独立修改仍可逐步进行", (t) => {
  const f = fixture(t, {
    "01": ticket(),
    "02": ticket("open", ["03"]),
    "03": "文件头损坏\n",
    "04": ticket(),
    "05": ticket(),
  });
  const uncertain = run(f, "set-deps", "01", "02");
  assert.equal(uncertain.status, 1);
  assert.equal(uncertain.error.error.code, "UNVERIFIABLE_CHANGE");
  assert.equal(uncertain.error.effects.ticketSaved, false);
  assert.equal(readFileSync(f.path("01"), "utf8"), ticket());
  const independent = run(f, "set-deps", "04", "05");
  assert.equal(independent.status, 0, independent.stderr);
  assert.equal(independent.data.valid, false);
  assert.equal(run(f, "set-status", "01", "--status", "in-progress").status, 0);
});

void test("空结果保留查询范围，完成值可配置，改文件名后缀不改变标识", (t) => {
  const f = fixture(
    t,
    {
      "001": ticket("shipped"),
      "02": ticket("resolved"),
      "03": ticket("working", ["001", "02"]),
    },
    { values: ["shipped", "resolved"] },
  );
  renameSync(f.path("001"), join(f.root, "issues", "001-新标题.md"));
  mkdirSync(join(f.root, "issues", "archive"));
  writeFileSync(
    join(f.root, "issues", "archive", "99-old.md"),
    "历史文件不参与当前票集",
  );
  writeFileSync(join(f.root, "issues", "README.md"), "说明文件不参与当前票集");
  const unblocked = run(f, "list", "--filter", "unblocked");
  assert.equal(unblocked.status, 0, unblocked.stderr);
  assert.deepEqual(
    unblocked.data.tickets.map((item) => item.id),
    ["03"],
  );
  const blocked = run(f, "list", "--filter", "blocked");
  assert.deepEqual(blocked.data.tickets, []);
  assert.equal(blocked.data.scope.config, f.config);
  assert.equal(blocked.data.total, 3);
  const empty = fixture(t, {});
  assert.equal(run(empty, "check").data.total, 0);
  assert.deepEqual(run(empty, "list").data.tickets, []);
});

void test("复制完整技能目录后在不同模块配置下仅靠 Node 即可查询和修改", async (t) => {
  for (const moduleType of [undefined, "module", "commonjs"]) {
    await t.test(moduleType ?? "无模块配置", (t) => {
      const f = fixture(t, { "01": ticket() });
      if (moduleType)
        writeFileSync(
          join(f.root, "package.json"),
          JSON.stringify({ type: moduleType }),
        );
      const isolated = join(f.root, "isolated-skill");
      cpSync(
        fileURLToPath(new URL("../skills/ticket-graph", import.meta.url)),
        isolated,
        { recursive: true },
      );
      for (const args of [
        ["check"],
        ["set-status", "01", "--status", "resolved"],
        ["list"],
        ["history"],
      ]) {
        const result = spawnSync(
          process.execPath,
          [
            join(isolated, "scripts", "ticket-graph.mts"),
            args[0]!,
            "--config",
            f.config,
            ...args.slice(1),
          ],
          {
            cwd: f.root,
            encoding: "utf8",
            env: { PATH: "/nonexistent", NODE_PATH: "", NODE_OPTIONS: "" },
          },
        );
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).kind, "data");
      }
      assert.equal(run(f, "list").data.tickets[0]!.delivery_complete, true);
    });
  }
});

void test("无效参数、无法读取配置和写入前文件故障不改票或历史", (t) => {
  const f = fixture(t, { "01": ticket() });
  for (const args of [
    ["unknown"],
    ["set-deps", "01"],
    ["set-deps", "01", "02", "--clear"],
    ["set-status", "01", "--status", ""],
    ["list", "--filter", "ready"],
    ["check", "--ticket", "01"],
    ["list", "--wat"],
    ["list", "--config", f.config],
  ]) {
    const result = run(f, ...args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.stdout, "");
  }
  const absent = run({ config: join(f.root, "absent.json") }, "list");
  assert.equal(absent.status, 1);
  assert.equal(absent.error.error.code, "READ_FAILED");
  assert.equal(readFileSync(f.path("01"), "utf8"), ticket());
  assert.equal(existsSync(f.history), false);
  assert.equal(readdirSync(join(f.root, "issues")).length, 1);
});

void test("无变化不重写票或追加历史", (t) => {
  const f = fixture(t, { "01": ticket() });
  const before = statSync(f.path("01"));
  assert.equal(
    run(f, "set-status", "01", "--status", "open").data.results[0]!.changed,
    false,
  );
  assert.equal(statSync(f.path("01")).mtimeMs, before.mtimeMs);
  assert.equal(existsSync(f.history), false);
});

void test(
  "无写权限时没有票或历史副作用",
  { skip: process.platform !== "linux" },
  (t) => {
    const f = fixture(t, { "01": ticket() });
    chmodSync(f.root, 0o755);
    chmodSync(join(f.root, "issues"), 0o555);
    try {
      const result = spawnSync(
        process.execPath,
        [cli, "set-status", "--config", f.config, "01", "--status", "resolved"],
        {
          encoding: "utf8",
          ...(process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {}),
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stderr);
      const error = failure(result.stderr);
      assert.equal(error.error.code, "LOCK_FAILED");
      assert.equal(error.effects.ticketSaved, false);
      assert.equal(readFileSync(f.path("01"), "utf8"), ticket());
      assert.equal(existsSync(f.history), false);
    } finally {
      chmodSync(join(f.root, "issues"), 0o755);
    }
  },
);

void test(
  "终端与管道使用相同的 JSON 结果",
  { skip: process.platform !== "linux" },
  (t) => {
    const f = fixture(t, { "01": ticket() });
    const piped = run(f, "list");
    const terminal = spawnSync(
      "script",
      [
        "-qefc",
        `${process.execPath} ${cli} list --config ${f.config}`,
        "/dev/null",
      ],
      { encoding: "utf8" },
    );
    assert.ifError(terminal.error);
    assert.equal(terminal.status, 0, terminal.stderr);
    assert.deepEqual(success(terminal.stdout), piped.data);
    assert.equal(terminal.stderr, "");
  },
);

void test("同目录的不同票集配置各有独立历史", (t) => {
  const f = fixture(t, { "01": ticket() });
  mkdirSync(join(f.root, "other"));
  writeFileSync(join(f.root, "other", "01-other.md"), ticket());
  const g = { config: join(f.root, "other-config.json") };
  writeFileSync(
    g.config,
    JSON.stringify({ tickets: "other", completion: { values: ["resolved"] } }),
  );
  const first = run(f, "set-status", "01", "--status", "resolved");
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(run(g, "history").data.events, []);
  const second = run(g, "set-status", "01", "--status", "working");
  assert.equal(second.status, 0, second.stderr);
  assert.notEqual(first.data.history, second.data.history);
  assert.equal(run(f, "history").data.events.length, 1);
  assert.equal(run(g, "history").data.events[0]!.after, "working");
});

void test("没有末尾换行的有效历史在追加后仍能完整查询", (t) => {
  const f = fixture(t, { "01": ticket() });
  assert.equal(run(f, "set-status", "01", "--status", "working").status, 0);
  writeFileSync(f.history, readFileSync(f.history, "utf8").trimEnd());
  assert.equal(run(f, "history").data.events.length, 1);
  const result = run(f, "set-status", "01", "--status", "resolved");
  assert.equal(result.status, 0, result.stderr);
  const history = run(f, "history");
  assert.equal(history.status, 0, history.stderr);
  assert.deepEqual(
    history.data.events.map((event) => event.after),
    ["working", "resolved"],
  );
});

void test("历史查询保留已有记录的附加信息，不收窄旧字段名", (t) => {
  const f = fixture(t, { "01": ticket() });
  const legacy = {
    ticket: "01",
    field: " ",
    time: "2026-10-01T00:00:00Z",
    before: "open",
    after: "done",
    note: { source: "旧工具", tags: ["保留"] },
  };
  writeFileSync(f.history, `${JSON.stringify(legacy)}\n`);
  const result = run(f, "history");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.data.events, [legacy]);
});

void test("下游短暂延迟读取时，长查询结果仍完整输出", async (t) => {
  const f = fixture(t, { "01": ticket("工作".repeat(30000)) });
  const child = spawn(process.execPath, [cli, "list", "--config", f.config]);
  child.stdout.setEncoding("utf8");
  let stdout = "",
    stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stdout.pause();
  const timer = setTimeout(() => child.stdout.resume(), 200);
  const status = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  clearTimeout(timer);
  assert.equal(status, 0, stderr);
  assert.ok(
    success(stdout).tickets[0]!.status === "工作".repeat(30000),
    "长状态值须完整保留",
  );
});
