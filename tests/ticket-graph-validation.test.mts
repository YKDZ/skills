import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { Completion } from "../skills/ticket-graph/scripts/types.mts";
import { success, failure } from "./cli-output.mts";

const cli = fileURLToPath(
  new URL("../skills/ticket-graph/scripts/ticket-graph.mts", import.meta.url),
);

function fixture(
  t: TestContext,
  files: Record<string, string>,
  completion: Completion = { values: ["resolved"] },
) {
  const root = mkdtempSync(join(tmpdir(), "ticket-graph-validation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "issues"));
  const config = join(root, "ticket-graph.json");
  writeFileSync(config, JSON.stringify({ tickets: "issues", completion }));
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(root, "issues", name), text);
  return { root, config, file: (name: string) => join(root, "issues", name) };
}

function ticket(status = "open", blockedBy: string[] = []) {
  return `---\nstatus: ${status}\nblocked_by: ${JSON.stringify(blockedBy)}\n---\n# 任务\n\n正文。\n`;
}

function run(f: { config: string }, ...args: string[]) {
  const result = spawnSync(
    process.execPath,
    [cli, "--config", f.config, ...args],
    { encoding: "utf8", cwd: tmpdir() },
  );
  assert.ifError(result.error);
  return result;
}

void test("检查合法票图时只读取文件头中的机器字段", (t) => {
  const body = '\n```yaml\nstatus: broken\nblocked_by: ["missing"]\n```\n';
  const f = fixture(t, {
    "01-ready.md": ticket("resolved") + body,
    "02-next.md": ticket("open", ["01"]),
  });
  const result = run(f, "check");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const data = success(result.stdout);
  assert.equal(data.command, "check");
  assert.equal(data.valid, true);
  assert.equal(data.total, 2);
  assert.equal(
    readFileSync(f.file("01-ready.md"), "utf8"),
    ticket("resolved") + body,
  );
});

void test("缺失必需字段时报告票、文件和字段，查询不得把损坏依赖当作空列表", (t) => {
  const original = "---\nstatus: open\n---\n# 任务\nblocked_by: []\n";
  const f = fixture(t, { "07-missing.md": original });
  for (const command of ["check", "list"]) {
    const result = run(f, command);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const error = failure(result.stderr).error;
    assert.equal(error.code, "INVALID_GRAPH");
    const issue = error.issues.find((item) => item.code === "MISSING_FIELD");
    assert.ok(issue);
    assert.equal(issue.ticket, "07");
    assert.equal(issue.file, f.file("07-missing.md"));
    assert.equal(issue.field, "blocked_by");
  }
  assert.equal(readFileSync(f.file("07-missing.md"), "utf8"), original);
});

void test("字符串状态和字符串数组依赖采用同一字段规则", (t) => {
  const f = fixture(t, {
    "01-number.md": "---\nstatus: 7\nblocked_by: []\n---\n",
    "02-scalar.md": '---\nstatus: open\nblocked_by: "01"\n---\n',
    "03-number-ref.md": "---\nstatus: open\nblocked_by: [1]\n---\n",
    "04-null.md": "---\nstatus: null\nblocked_by: null\n---\n",
  });
  const result = run(f, "check");
  assert.equal(result.status, 1);
  const error = failure(result.stderr).error;
  assert.equal(error.code, "INVALID_GRAPH");
  assert.deepEqual(
    error.issues.map((item) => [item.code, item.ticket, item.field]),
    [
      ["INVALID_FIELD", "01", "status"],
      ["INVALID_FIELD", "02", "blocked_by"],
      ["INVALID_FIELD", "03", "blocked_by"],
      ["INVALID_FIELD", "04", "status"],
      ["INVALID_FIELD", "04", "blocked_by"],
    ],
  );
});

void test("文件头必须位于首部、闭合且为有效 YAML 映射", (t) => {
  const f = fixture(t, {
    "01-body.md": `# 正文\n${ticket()}`,
    "02-unclosed.md": "---\nstatus: open\nblocked_by: []\n",
    "03-sequence.md": "---\n- open\n- []\n---\n",
    "04-broken.md": "---\nstatus: open\nblocked_by: [\n---\n",
  });
  const result = run(f, "check");
  assert.equal(result.status, 1);
  const error = failure(result.stderr).error;
  assert.equal(error.code, "INVALID_GRAPH");
  for (const [id, code] of [
    ["01", "MISSING_FRONTMATTER"],
    ["02", "UNCLOSED_FRONTMATTER"],
    ["03", "INVALID_FRONTMATTER"],
    ["04", "INVALID_YAML"],
  ]) {
    const item = error.issues.find((issue) => issue.ticket === id);
    assert.ok(item);
    assert.equal(item.code, code);
    assert.equal(typeof item.file, "string");
  }
});

void test("重复字段和重复票标识均定位到冲突来源", (t) => {
  const f = fixture(t, {
    "01-a.md": ticket(),
    "01-b.md": ticket(),
    "02-duplicate.md":
      "---\nstatus: open\nblocked_by: []\nstatus: resolved\n---\n",
    "03-extra.md":
      "---\nstatus: open\nblocked_by: []\nowner: 张三\nowner: 李四\n---\n",
  });
  const result = run(f, "check");
  assert.equal(result.status, 1);
  const issues = failure(result.stderr).error.issues;
  assert.deepEqual(
    issues
      .filter((item) => item.code === "DUPLICATE_ID")
      .map((item) => item.file)
      .toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
    [f.file("01-a.md"), f.file("01-b.md")],
  );
  assert.deepEqual(
    issues
      .filter((item) => item.code === "DUPLICATE_FIELD")
      .map((item) => [item.ticket, item.field]),
    [
      ["02", "status"],
      ["03", "owner"],
    ],
  );
});

void test("缺失引用和自依赖保留声明票及目标标识", (t) => {
  const f = fixture(t, {
    "01-missing.md": ticket("open", ["003"]),
    "02-self.md": ticket("open", ["02"]),
  });
  const result = run(f, "check");
  assert.equal(result.status, 1);
  const issues = failure(result.stderr).error.issues;
  assert.deepEqual(
    issues.map((item) => [item.code, item.ticket, item.target, item.field]),
    [
      ["MISSING_REFERENCE", "01", "003", "blocked_by"],
      ["SELF_DEPENDENCY", "02", "02", "blocked_by"],
    ],
  );
});

void test("环报告沿真实依赖方向形成的路径，交付完成不会抹掉结构错误", (t) => {
  const f = fixture(t, {
    "01-a.md": ticket("resolved", ["03"]),
    "02-b.md": ticket("open", ["01"]),
    "03-c.md": ticket("open", ["02"]),
  });
  const result = run(f, "check");
  assert.equal(result.status, 1);
  const cycle = failure(result.stderr).error.issues.find(
    (item) => item.code === "CYCLE",
  );
  assert.ok(cycle);
  assert.deepEqual(cycle.path, ["01", "03", "02", "01"]);
  assert.equal(cycle.field, "blocked_by");
  assert.equal(cycle.ticket, "01");
});

void test("机器字段中的锚点和别名被明确定位，避免修改连带改变其他字段", (t) => {
  const f = fixture(t, {
    "01-anchor.md":
      "---\nstatus: &state open\nblocked_by: []\nextra: *state\n---\n",
    "02-alias.md":
      "---\nextra: &state open\nstatus: *state\nblocked_by: []\n---\n",
    "03-nested-anchor.md":
      '---\nstatus: open\nblocked_by: [&dep "01"]\nextra: *dep\n---\n',
  });
  const result = run(f, "check");
  assert.equal(result.status, 1);
  const issues = failure(result.stderr).error.issues;
  assert.deepEqual(
    issues.map((item) => [item.code, item.ticket, item.field]),
    [
      ["UNSAFE_FIELD", "01", "status"],
      ["UNSAFE_FIELD", "02", "status"],
      ["UNSAFE_FIELD", "03", "blocked_by"],
    ],
  );
});

void test("空白状态及非数字依赖不满足机器字段格式", (t) => {
  const f = fixture(t, {
    "01-blank.md": '---\nstatus: "  "\nblocked_by: []\n---\n',
    "02-nonnumeric.md": ticket("open", ["later"]),
  });
  const result = run(f, "check");
  assert.equal(result.status, 1);
  assert.deepEqual(
    failure(result.stderr).error.issues.map((item) => [
      item.code,
      item.ticket,
      item.field,
    ]),
    [
      ["INVALID_FIELD", "01", "status"],
      ["INVALID_FIELD", "02", "blocked_by"],
    ],
  );
});

void test("修改块标量状态保留行末注释、其他字段、正文及 CRLF 换行", (t) => {
  const original =
    "---\r\nstatus: |- # 当前状态\r\n  open\r\nblocked_by: [] # 前置\r\nextra:\r\n  status: 保留\r\n---\r\n# 任务\r\n\r\nstatus: 正文保持原样\r\n";
  const f = fixture(t, { "01-block.md": original });
  const result = run(f, "set-status", "01", "resolved");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).changed, true);
  assert.equal(
    readFileSync(f.file("01-block.md"), "utf8"),
    '---\r\nstatus: "resolved" # 当前状态\r\nblocked_by: [] # 前置\r\nextra:\r\n  status: 保留\r\n---\r\n# 任务\r\n\r\nstatus: 正文保持原样\r\n',
  );
  const check = run(f, "check");
  assert.equal(check.status, 0, check.stderr);
});

void test("替换块序列依赖保留字段前后的注释与其他元数据", (t) => {
  const original =
    '---\nstatus: open\nblocked_by: # 前置说明\n  - "01"\n  - "02" # 尾注\n\n# 所有者说明\nowner: "张三"\n---\n正文\n';
  const f = fixture(t, {
    "01-a.md": ticket(),
    "02-b.md": ticket(),
    "03-block.md": original,
  });
  const result = run(f, "set-deps", "03", "02");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(f.file("03-block.md"), "utf8"),
    '---\nstatus: open\nblocked_by: # 前置说明\n  ["02"] # 尾注\n\n# 所有者说明\nowner: "张三"\n---\n正文\n',
  );
  assert.equal(run(f, "check").status, 0);
});

void test("无缩进的块序列可显式清空，并保留 CRLF 与后续字段", (t) => {
  const original =
    '---\r\nstatus: open\r\nblocked_by:\r\n- "01" # 前置\r\nowner: 张三\r\n---\r\n正文\r\n';
  const f = fixture(t, { "01-a.md": ticket(), "02-block.md": original });
  const result = run(f, "set-deps", "02", "--clear");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(f.file("02-block.md"), "utf8"),
    "---\r\nstatus: open\r\nblocked_by:\r\n  [] # 前置\r\nowner: 张三\r\n---\r\n正文\r\n",
  );
});

void test("删除旧环边允许旧环拆成较小的环，并报告独立剩余问题", (t) => {
  const f = fixture(t, {
    "01-a.md": ticket("open", ["02", "03"]),
    "02-b.md": ticket("open", ["01"]),
    "03-c.md": ticket("open", ["04"]),
    "04-d.md": ticket("open", ["01", "03"]),
    "05-missing.md": ticket("open", ["99"]),
  });
  const result = run(f, "set-deps", "01", "02");
  assert.equal(result.status, 0, result.stderr);
  const data = success(result.stdout);
  assert.equal(data.changed, true);
  assert.deepEqual(
    data.issues
      .filter((item) => item.code === "CYCLE")
      .map((item) => item.path)
      .toSorted((a, b) =>
        (a ?? []).join(",").localeCompare((b ?? []).join(",")),
      ),
    [
      ["01", "02", "01"],
      ["03", "04", "03"],
    ],
  );
  assert.equal(
    data.issues.find((item) => item.code === "MISSING_REFERENCE")!.ticket,
    "05",
  );
  assert.equal(readFileSync(f.file("01-a.md"), "utf8"), ticket("open", ["02"]));
});

void test("旧环中的新增环边仍被拒绝，不能只比较环的票集合", (t) => {
  const original = ticket("open", ["02"]);
  const f = fixture(t, {
    "01-a.md": original,
    "02-b.md": ticket("open", ["03"]),
    "03-c.md": ticket("open", ["01"]),
  });
  const result = run(f, "set-deps", "01", "02", "03");
  assert.equal(result.status, 1);
  const data = failure(result.stderr);
  assert.equal(data.error.code, "INVALID_CHANGE");
  assert.equal(
    data.error.issues.some((item) => item.code === "CYCLE"),
    true,
  );
  assert.equal(data.effects.ticketSaved, false);
  assert.equal(readFileSync(f.file("01-a.md"), "utf8"), original);
});

void test("可修复错类型的块映射依赖，并完整保留其他字段", (t) => {
  const original =
    "---\nstatus: open\nblocked_by:\n  wrong:\n    - true # 原值尾注\nowner: 张三\n---\n正文\n";
  const f = fixture(t, { "01-bad-type.md": original });
  const before = run(f, "check");
  assert.equal(JSON.parse(before.stderr).error.issues[0].code, "INVALID_FIELD");
  const result = run(f, "set-deps", "01", "--clear");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(f.file("01-bad-type.md"), "utf8"),
    "---\nstatus: open\nblocked_by:\n  [] # 原值尾注\nowner: 张三\n---\n正文\n",
  );
  assert.equal(run(f, "check").status, 0);
});

void test("最后一项使用块标量的依赖序列可替换且不吞掉下一字段", (t) => {
  const original =
    "---\nstatus: open\nblocked_by:\n  - |-\n    01\nowner: 张三\n---\n正文\n";
  const f = fixture(t, { "01-a.md": ticket(), "02-last-block.md": original });
  assert.equal(run(f, "check").status, 0);
  const result = run(f, "set-deps", "02", "--clear");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(f.file("02-last-block.md"), "utf8"),
    "---\nstatus: open\nblocked_by:\n  []\nowner: 张三\n---\n正文\n",
  );
});

void test("空值字段可通过命令修复，保留相邻注释与空行", (t) => {
  const f = fixture(t, {
    "01-null.md": "---\nstatus:\n# 前置说明\nblocked_by: []\n---\n正文\n",
  });
  const result = run(f, "set-status", "01", "resolved");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(f.file("01-null.md"), "utf8"),
    '---\nstatus: "resolved"\n# 前置说明\nblocked_by: []\n---\n正文\n',
  );
});

void test("修复错类型字段时，结果与历史保留实际旧值", (t) => {
  const f = fixture(t, {
    "01-number.md": "---\nstatus: 7\nblocked_by: []\n---\n正文\n",
  });
  const result = run(f, "set-status", "01", "resolved");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).before, 7);
  const history = run(f, "history", "--ticket", "01");
  assert.equal(history.status, 0, history.stderr);
  assert.equal(JSON.parse(history.stdout).events[0].before, 7);
});

void test("旧值无法被 JSON 忠实记录时拒绝修改，避免历史把非有限数字记成空值", (t) => {
  const original = "---\nstatus: .inf\nblocked_by: []\n---\n正文\n";
  const f = fixture(t, { "01-infinity.md": original });
  const result = run(f, "set-status", "01", "resolved");
  assert.equal(result.status, 1);
  assert.equal(failure(result.stderr).error.code, "UNEDITABLE_FIELD");
  assert.equal(readFileSync(f.file("01-infinity.md"), "utf8"), original);
});

void test("JSON 转换会合并映射键或舍入整数时拒绝修改且不追加历史", (t) => {
  const cases = [
    '---\nstatus:\n  1: first\n  "1": second\nblocked_by: []\n---\n正文\n',
    "---\nstatus: 9007199254740993\nblocked_by: []\n---\n正文\n",
  ];
  for (const original of cases) {
    const f = fixture(t, { "01-lossy.md": original });
    const result = run(f, "set-status", "01", "resolved");
    assert.equal(result.status, 1, original);
    assert.equal(failure(result.stderr).error.code, "UNEDITABLE_FIELD");
    assert.equal(readFileSync(f.file("01-lossy.md"), "utf8"), original);
    const history = run(f, "history", "--ticket", "01");
    assert.equal(history.status, 0, history.stderr);
    assert.deepEqual(JSON.parse(history.stdout).events, []);
  }
});
