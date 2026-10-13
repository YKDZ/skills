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
  chmodSync,
  openSync,
  closeSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { success, failure } from "./cli-output.mts";

const cli = fileURLToPath(
  new URL("../skills/ticket-graph/scripts/ticket-graph.mts", import.meta.url),
);
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "ticket-graph-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    config: join(root, "ticket-graph.json"),
    directory: join(root, "issues"),
  };
}
function run(f: { config: string }, ...args: string[]) {
  const result = spawnSync(
    process.execPath,
    [cli, "--config", f.config, ...args],
    { encoding: "utf8", cwd: tmpdir() },
  );
  assert.ifError(result.error);
  return {
    ...result,
    data: success(result.stdout || "{}"),
    error: failure(result.stderr || "{}"),
  };
}

void test("配置只指定完成值，状态修改固定使用 status 并保留旧历史", (t) => {
  const f = fixture(t);
  mkdirSync(f.directory);
  writeFileSync(
    f.config,
    JSON.stringify({
      tickets: "issues",
      completion: { values: ["shipped", "resolved"] },
    }),
  );
  const ticket = join(f.directory, "01-first.md");
  writeFileSync(
    ticket,
    "---\nstatus: open\nphase: legacy\nblocked_by: []\n---\n正文。\n",
  );
  const legacy = {
    ticket: "01",
    field: "phase",
    before: "open",
    after: "legacy",
    time: "2026-10-01T00:00:00Z",
  };
  writeFileSync(`${f.config}.history.jsonl`, `${JSON.stringify(legacy)}\n`);
  assert.equal(run(f, "check").status, 0);
  const update = run(f, "set-status", "01", "shipped");
  assert.equal(update.status, 0, update.stderr);
  assert.equal(update.data.field, "status");
  assert.equal(
    readFileSync(ticket, "utf8"),
    '---\nstatus: "shipped"\nphase: legacy\nblocked_by: []\n---\n正文。\n',
  );
  assert.equal(run(f, "list").data.tickets[0]!.delivery_complete, true);
  const history = run(f, "history").data.events;
  assert.deepEqual(history[0], legacy);
  assert.equal(history[1]!.field, "status");
  assert.equal(run(f, "set-status", "01", "working").status, 0);
  assert.equal(run(f, "list").data.tickets[0]!.delivery_complete, false);
});

void test("初始化保留目录与多个完成值，生成的配置可直接检查和修改票图", (t) => {
  const f = fixture(t);
  mkdirSync(f.directory);
  const ticket = join(f.directory, "01-first.md");
  writeFileSync(ticket, "---\nstatus: open\nblocked_by: []\n---\n正文。\n");
  const result = run(
    f,
    "init",
    "--tickets",
    "issues",
    "--completion-value",
    "resolved",
    "--completion-value",
    " shipped ",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.data.command, "init");
  assert.equal(result.data.created, true);
  assert.deepEqual(result.data.scope, {
    config: f.config,
    tickets: f.directory,
  });
  const config = JSON.parse(readFileSync(f.config, "utf8"));
  assert.equal(config.tickets, "issues");
  assert.deepEqual(config.completion, { values: ["resolved", " shipped "] });
  const schema = JSON.parse(
    readFileSync(new URL(config.$schema, pathToFileURL(f.config)), "utf8"),
  );
  assert.equal(schema.type, "object");
  assert.deepEqual(readdirSync(f.root).sort(), ["issues", "ticket-graph.json"]);
  assert.equal(existsSync(`${f.config}.history.jsonl`), false);
  assert.equal(run(f, "check").status, 0);
  assert.equal(run(f, "set-status", "01", " shipped ").status, 0);
  assert.equal(run(f, "list").data.tickets[0]!.delivery_complete, true);
});

void test("所有读取命令拒绝已移除的配置字段，并定位字段且不修改文件", (t) => {
  const f = fixture(t);
  mkdirSync(f.directory);
  const original = JSON.stringify({
    tickets: "issues",
    completion: { field: "status", values: ["resolved"] },
  });
  writeFileSync(f.config, original);
  for (const args of [
    ["check"],
    ["list"],
    ["history"],
    ["set-status", "01", "resolved"],
    ["set-deps", "01", "--clear"],
  ]) {
    const result = run(f, ...args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.stdout, "");
    assert.equal(result.error.error.code, "INVALID_CONFIG");
    assert.equal(result.error.error.file, f.config);
    assert.ok(
      result.error.error.issues.some(
        (issue) => issue.path === "/completion/field",
      ),
    );
    assert.equal(result.error.effects.ticketSaved, false);
    assert.equal(result.error.effects.historySaved, false);
    assert.equal(readFileSync(f.config, "utf8"), original);
  }
  assert.deepEqual(readdirSync(f.directory), []);
  assert.equal(existsSync(`${f.config}.history.jsonl`), false);
});

void test("初始化只创建配置，票目录缺失和票图错误由 check 报告", (t) => {
  const f = fixture(t);
  const result = run(
    f,
    "init",
    "--tickets",
    f.directory,
    "--completion-value",
    "done",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(f.config, "utf8")).tickets, f.directory);
  assert.deepEqual(readdirSync(f.root), ["ticket-graph.json"]);
  assert.equal(run(f, "check").error.error.code, "READ_FAILED");
  mkdirSync(f.directory);
  writeFileSync(join(f.directory, "01-broken.md"), "旧格式，等待迁移。");
  const g = { ...f, config: join(f.root, "second.json") };
  assert.equal(
    run(g, "init", "--tickets", "issues", "--completion-value", "done").status,
    0,
  );
  assert.equal(run(g, "check").error.error.code, "INVALID_GRAPH");
  assert.equal(
    readFileSync(join(f.directory, "01-broken.md"), "utf8"),
    "旧格式，等待迁移。",
  );
  assert.equal(existsSync(`${g.config}.history.jsonl`), false);
});

void test("初始化拒绝无效参数和候选配置，已有配置保持原样", (t) => {
  const f = fixture(t);
  const init = ["init", "--tickets", "issues", "--completion-value", "done"];
  for (const args of [
    ["init"],
    ["init", "--tickets", "issues"],
    ["init", "--completion-value", "done"],
    [...init, "extra"],
    [...init, "--tickets", "other"],
    [...init, "--filter", "all"],
    [...init, "--completion-field", "status"],
    [...init, "--force"],
    ["check", "--tickets", "issues"],
    ["list", "--completion-value", "done"],
  ]) {
    const result = run(f, ...args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.error.error.code, "USAGE");
    assert.equal(result.error.effects.configCreated, false);
    assert.deepEqual(readdirSync(f.root), []);
  }
  for (const [tickets, value, path] of [
    ["", "done", "/tickets"],
    ["issues", " \t", "/completion/values/0"],
  ] as const) {
    const result = run(
      f,
      "init",
      "--tickets",
      tickets,
      "--completion-value",
      value,
    );
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.error.error.code, "INVALID_CONFIG");
    assert.ok(result.error.error.issues.some((issue) => issue.path === path));
    assert.deepEqual(readdirSync(f.root), []);
  }
  writeFileSync(f.config, "已有配置，即使尚未通过校验也不可覆盖。");
  const result = run(f, ...init);
  assert.equal(result.status, 1);
  assert.equal(result.error.error.code, "CONFIG_EXISTS");
  assert.equal(result.error.effects.configCreated, false);
  assert.equal(result.error.effects.configSaved, false);
  assert.equal(
    readFileSync(f.config, "utf8"),
    "已有配置，即使尚未通过校验也不可覆盖。",
  );
});

void test("缺少或不可写的父目录使初始化失败且不产生文件", (t) => {
  const f = fixture(t);
  const nested = { config: join(f.root, "absent", "ticket-graph.json") };
  const missing = run(
    nested,
    "init",
    "--tickets",
    "issues",
    "--completion-value",
    "done",
  );
  assert.equal(missing.status, 1);
  assert.equal(missing.error.error.code, "WRITE_FAILED");
  assert.equal(missing.error.effects.configCreated, false);
  assert.deepEqual(readdirSync(f.root), []);
  chmodSync(f.root, 0o555);
  try {
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "--config",
        f.config,
        "init",
        "--tickets",
        "issues",
        "--completion-value",
        "done",
      ],
      {
        encoding: "utf8",
        ...(process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {}),
      },
    );
    assert.equal(result.status, 1, result.stderr);
    const error = failure(result.stderr);
    assert.equal(error.error.code, "WRITE_FAILED");
    assert.equal(error.effects.configCreated, false);
    assert.deepEqual(readdirSync(f.root), []);
  } finally {
    chmodSync(f.root, 0o700);
  }
});

void test("并行初始化同一配置只有一次创建成功", async (t) => {
  const f = fixture(t);
  const launch = (value: string) =>
    new Promise<{
      status: number | null;
      stdout: string;
      stderr: string;
      value: string;
    }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "--config",
        f.config,
        "init",
        "--tickets",
        "issues",
        "--completion-value",
        value,
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
      child.on("close", (status) => resolve({ status, stdout, stderr, value }));
    });
  const results = await Promise.all([launch("done"), launch("resolved")]);
  assert.deepEqual(
    results
      .map((result) => result.status)
      .sort((a, b) => (a ?? -1) - (b ?? -1)),
    [0, 1],
  );
  const winner = results.find((result) => result.status === 0);
  assert.ok(winner);
  assert.equal(JSON.parse(winner.stdout).created, true);
  assert.deepEqual(
    JSON.parse(readFileSync(f.config, "utf8")).completion.values,
    [winner.value],
  );
  const loser = JSON.parse(
    results.find((result) => result.status === 1)!.stderr,
  );
  assert.equal(loser.error.code, "CONFIG_EXISTS");
  assert.equal(loser.effects.configCreated, false);
});

void test(
  "输出故障不抹掉已保存的配置",
  { skip: process.platform !== "linux" },
  (t) => {
    assert.ok(existsSync("/dev/full"), "Linux 验收需要 /dev/full。");
    const f = fixture(t);
    const full = openSync("/dev/full", "w");
    let result;
    try {
      result = spawnSync(
        process.execPath,
        [
          cli,
          "--config",
          f.config,
          "init",
          "--tickets",
          "issues",
          "--completion-value",
          "done",
        ],
        {
          stdio: ["ignore", full, "pipe"],
          encoding: "utf8",
        },
      );
    } finally {
      closeSync(full);
    }
    assert.equal(result.status, 1);
    const error = failure(result.stderr);
    assert.equal(error.error.code, "OUTPUT_FAILED");
    assert.equal(error.effects.configCreated, true);
    assert.equal(error.effects.configSaved, true);
    assert.deepEqual(
      JSON.parse(readFileSync(f.config, "utf8")).completion.values,
      ["done"],
    );
  },
);

void test(
  "配置只写入一部分时报告已创建及保存结果不确定",
  { skip: process.platform !== "linux" },
  (t) => {
    const f = fixture(t);
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        'ulimit -f 1; trap "" XFSZ; exec "$@"',
        "init-test",
        process.execPath,
        cli,
        "--config",
        f.config,
        "init",
        "--tickets",
        "issues",
        "--completion-value",
        "x".repeat(4000),
      ],
      { encoding: "utf8" },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    const error = failure(result.stderr);
    assert.equal(error.error.code, "WRITE_FAILED");
    assert.equal(error.effects.configCreated, true);
    assert.equal(error.effects.configSaved, null);
    const partial = readFileSync(f.config, "utf8");
    assert.ok(partial.length > 0 && partial.length < 4000);
    assert.throws(() => JSON.parse(partial), SyntaxError);
    assert.equal(
      run(f, "init", "--tickets", "issues", "--completion-value", "done").error
        .error.code,
      "CONFIG_EXISTS",
    );
    assert.equal(readFileSync(f.config, "utf8"), partial);
  },
);

void test("配置语法错误与结构错误区分，缺失和特殊字符字段均可定位", (t) => {
  const f = fixture(t);
  writeFileSync(f.config, "{broken");
  const syntax = run(f, "check");
  assert.equal(syntax.status, 1);
  assert.equal(syntax.error.error.code, "INVALID_CONFIG");
  assert.equal(syntax.error.error.file, f.config);
  assert.equal(syntax.error.error.issues, undefined);
  writeFileSync(f.config, JSON.stringify({ completion: {}, "a/b~c": true }));
  const structure = run(f, "check");
  assert.equal(structure.status, 1);
  const issues = structure.error.error.issues;
  assert.ok(
    issues.some(
      (issue) => issue.path === "/tickets" && issue.keyword === "required",
    ),
  );
  assert.ok(
    issues.some(
      (issue) =>
        issue.path === "/completion/values" && issue.keyword === "required",
    ),
  );
  assert.ok(
    issues.some(
      (issue) =>
        issue.path === "/a~1b~0c" && issue.keyword === "additionalProperties",
    ),
  );
  assert.notEqual(syntax.error.error.message, structure.error.error.message);
});

void test("复制技能后可离线初始化，特殊字符路径的结构定义引用仍可解析", (t) => {
  const f = fixture(t);
  const skill = join(f.root, "skill # % 中文");
  cpSync(
    fileURLToPath(new URL("../skills/ticket-graph/", import.meta.url)),
    skill,
    { recursive: true },
  );
  const localCli = join(skill, "scripts", "ticket-graph.mts");
  const project = join(f.root, "project");
  mkdirSync(project);
  const config = join(project, "ticket-graph.json");
  const offline = {
    encoding: "utf8" as const,
    cwd: f.root,
    env: { PATH: "/nonexistent", NODE_PATH: "", NODE_OPTIONS: "" },
  };
  const init = spawnSync(
    process.execPath,
    [
      localCli,
      "--config",
      relative(f.root, config),
      "init",
      "--tickets",
      ".",
      "--completion-value",
      "done",
    ],
    offline,
  );
  assert.equal(init.status, 0, init.stderr);
  assert.deepEqual(JSON.parse(init.stdout).scope, { config, tickets: project });
  const value = JSON.parse(readFileSync(config, "utf8"));
  assert.equal(
    fileURLToPath(new URL(value.$schema, pathToFileURL(config))),
    join(skill, "ticket-graph.schema.json"),
  );
  writeFileSync(
    join(project, "01-a.md"),
    "---\nstatus: open\nblocked_by: []\n---\n",
  );
  for (const args of [["check"], ["set-status", "01", "done"], ["list"]]) {
    const result = spawnSync(
      process.execPath,
      [localCli, "--config", config, ...args],
      offline,
    );
    assert.equal(result.status, 0, result.stderr);
    if (args[0] === "list")
      assert.equal(
        JSON.parse(result.stdout).tickets[0].delivery_complete,
        true,
      );
  }
  value.$schema = "./不存在的定义.json";
  writeFileSync(config, JSON.stringify(value));
  assert.equal(
    spawnSync(
      process.execPath,
      [localCli, "--config", config, "check"],
      offline,
    ).status,
    0,
  );
});
