import assert from "node:assert/strict";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import {
  changeSchema,
  failureSchema,
  inputs,
  outputs,
} from "../skills/ticket-graph/scripts/contracts.mts";
import { s } from "../skills/ticket-graph/scripts/schema.mts";
import type { Schema } from "../skills/ticket-graph/scripts/schema.mts";
import {
  defineCli,
  executeCli,
  parseCliInvocation,
  helpCapability,
  outputCapability,
} from "../skills/ticket-graph/scripts/vendor/cli-contract.mjs";

const scope = { config: "graph.json", tickets: "issues" };
const row = {
  ticket: "01",
  field: "status",
  before: 7,
  after: "done",
  changed: true,
  state: "saved",
  ticketSaved: true,
  historySaved: true,
};
const update = {
  scope,
  history: "graph.json.history.jsonl",
  valid: true,
  issues: [],
};
const issue = {
  code: "MISSING_REFERENCE",
  message: "缺少前置票",
  ticket: "01",
  file: "01.md",
  key: "reference:01:02",
  target: "02",
};
const sampleGroups: readonly [
  Schema<unknown>,
  readonly [unknown, boolean][],
][] = [
  [
    inputs.init,
    [
      [
        {
          config: "graph.json",
          tickets: "issues",
          completionValues: ["done", " shipped "],
        },
        true,
      ],
      [
        { config: "graph.json", tickets: "issues", completionValues: [] },
        false,
      ],
      [
        { config: "graph.json", tickets: "issues", completionValues: [7] },
        false,
      ],
    ],
  ],
  [
    inputs.check,
    [
      [{ config: "graph.json" }, true],
      [{}, false],
      [{ config: "graph.json", extra: true }, false],
    ],
  ],
  [
    inputs.list,
    [
      [{ config: "graph.json" }, true],
      [{ config: "graph.json", filter: "unblocked" }, true],
      [{ config: "graph.json", filter: "ready" }, false],
    ],
  ],
  [
    inputs.history,
    [
      [{ config: "graph.json", ticket: "001" }, true],
      [{ config: "graph.json", ticket: 1 }, false],
      [{ config: "graph.json", ticket: "a" }, false],
    ],
  ],
  [
    inputs.setStatus,
    [
      [
        { config: "graph.json", tickets: ["01", "002"], status: " done " },
        true,
      ],
      [{ config: "graph.json", tickets: [], status: "done" }, false],
      [{ config: "graph.json", tickets: ["x"], status: "done" }, false],
      [{ config: "graph.json", tickets: ["01", 2], status: "done" }, false],
      [{ config: "graph.json", tickets: ["01"], status: "\t\n" }, false],
    ],
  ],
  [
    inputs.setDeps,
    [
      [{ config: "graph.json", ticket: "01", clear: true }, true],
      [{ config: "graph.json", ticket: "01", dependencies: ["02"] }, true],
      [{ config: "graph.json", ticket: "01", clear: false }, false],
      [{ config: "graph.json", ticket: "01" }, false],
      [{ config: "graph.json", ticket: "01", dependencies: [] }, false],
      [
        {
          config: "graph.json",
          ticket: "01",
          dependencies: ["02"],
          clear: true,
        },
        false,
      ],
    ],
  ],
  [
    outputs.init,
    [
      [{ scope, created: true }, true],
      [{ scope }, false],
      [{ scope, created: "yes" }, false],
    ],
  ],
  [
    outputs.check,
    [
      [{ scope, valid: true, total: 2 }, true],
      [{ scope, valid: true, total: "2" }, false],
    ],
  ],
  [
    outputs.list,
    [
      [{ scope, filter: "all", total: 0, tickets: [] }, true],
      [
        {
          scope,
          filter: "unblocked",
          total: 1,
          tickets: [
            {
              id: "01",
              file: "01.md",
              status: "open",
              delivery_complete: false,
              blocked_by: [],
              blocked_by_unfinished: [],
            },
          ],
        },
        true,
      ],
      [{ scope, filter: "ready", total: 0, tickets: [] }, false],
    ],
  ],
  [
    outputs.setStatus,
    [
      [{ ...update, results: [row] }, true],
      [
        {
          ...update,
          valid: false,
          issues: [issue],
          results: [{ ...row, before: { damaged: [null, 3, false] } }],
        },
        true,
      ],
      [{ ...update, results: [{ ...row, historySaved: "yes" }] }, false],
      [{ ...update, results: [{ ...row, state: "pending" }] }, false],
    ],
  ],
  [
    outputs.setDeps,
    [
      [
        { ...update, ...row, field: "blocked_by", before: ["02"], after: [] },
        true,
      ],
      [{ ...update, ...row, after: 7 }, false],
    ],
  ],
  [
    outputs.history,
    [
      [
        {
          scope: {
            config: "graph.json",
            history: "history.jsonl",
            ticket: null,
          },
          events: [],
        },
        true,
      ],
      [
        {
          scope: {
            config: "graph.json",
            history: "history.jsonl",
            ticket: "01",
          },
          events: [
            {
              ticket: "01",
              field: " ",
              time: "2026-10-01T00:00:00Z",
              before: [1, true, null],
              after: { old: "value" },
              note: { source: "旧工具", tags: ["保留"] },
            },
          ],
        },
        true,
      ],
      [
        {
          scope: {
            config: "graph.json",
            history: "history.jsonl",
            ticket: null,
          },
          events: [{ ticket: "01" }],
        },
        false,
      ],
    ],
  ],
  [
    failureSchema,
    [
      [
        {
          error: {
            code: "INVALID_CONFIG",
            message: "字段错误",
            issues: [
              { path: "/tickets", keyword: "type", message: "应为字符串" },
            ],
          },
          effects: {
            configCreated: false,
            configSaved: false,
            ticketSaved: false,
            historySaved: false,
          },
        },
        true,
      ],
      [
        {
          error: { code: "WRITE_FAILED", message: "未保存" },
          effects: {
            configCreated: false,
            configSaved: false,
            ticketSaved: false,
            historySaved: false,
            results: [row],
          },
        },
        true,
      ],
      [{ error: { code: "UNKNOWN" }, effects: {} }, false],
    ],
  ],
  [
    changeSchema,
    [
      [{ ...row, before: null }, true],
      [{ ...row, before: [1, "old"] }, true],
      [{ ...row, ticket: "wrong" }, false],
      [{ ...row, extra: true }, false],
    ],
  ],
];

void test("命令输入和输出模式与公开 JSON Schema 接受同一组值", () => {
  const ajv = new Ajv2020({ allErrors: true });
  for (const [schema, samples] of sampleGroups) {
    for (const project of [
      schema["~standard"].jsonSchema.input,
      schema["~standard"].jsonSchema.output,
    ]) {
      const validate = ajv.compile(project({ target: "draft-2020-12" }));
      for (const [value, expected] of samples) {
        const before = structuredClone(value);
        assert.equal(schema.accepts(value), expected, JSON.stringify(value));
        assert.equal(validate(value), expected, JSON.stringify(value));
        assert.deepEqual(value, before);
      }
    }
  }
});

void test("模式拒绝非 JSON 值，并定位嵌套错误和缺失字段", () => {
  const cycle: unknown[] = [];
  cycle.push(cycle);
  const symbol = { [Symbol("隐藏")]: 1 };
  for (const value of [
    undefined,
    NaN,
    Infinity,
    1n,
    () => 1,
    Symbol("值"),
    new Date(),
    new Map(),
    cycle,
    symbol,
    [undefined],
    Array<unknown>(1),
    { value: undefined },
    { ...row, before: undefined },
  ])
    assert.equal(s.jsonValue().accepts(value), false);
  assert.equal(
    outputs.setStatus.accepts({
      ...update,
      results: [{ ...row, before: undefined }],
    }),
    false,
  );
  assert.deepEqual(
    inputs.setStatus.problem({
      config: "graph.json",
      tickets: ["01", "bad"],
      status: "done",
    })?.path,
    ["tickets", 1],
  );
  assert.deepEqual(inputs.check.problem({})?.path, ["config"]);
  assert.deepEqual(
    inputs.setDeps.problem({ config: "graph.json", ticket: "01" })?.path,
    [],
  );
  assert.deepEqual(
    outputs.setStatus.problem({
      ...update,
      results: [{ ...row, historySaved: "yes" }],
    })?.path,
    ["results", 0, "historySaved"],
  );
});

void test("实际契约拒绝绕过类型检查的无效运行时结果，且不输出成功信息", async () => {
  const define = defineCli();
  const cli = define({
    root: "probe",
    help: helpCapability(),
    output: outputCapability({ defaultFormat: "structured" }),
    usageFailureExitCode: 2,
    commands: {
      probe: {
        kind: "rootCommand",
        name: "probe",
        description: "验证契约结果",
        fields: {},
        input: s.object({}),
        success: {
          kind: "data",
          variants: {
            result: { description: "结果", schema: outputs.check, exitCode: 0 },
          },
        },
        failures: {},
        handler({ outcome }) {
          return outcome.data.result(
            JSON.parse('{"scope":{},"valid":"yes","total":0}'),
          );
        },
      },
    },
  });
  const chunks: string[] = [];
  await assert.rejects(
    executeCli(cli, {
      invocation: parseCliInvocation(cli, []),
      dependencies: undefined,
      write: ({ chunk }) => {
        chunks.push(chunk);
      },
    }),
    { name: "ContractExecutionError" },
  );
  assert.deepEqual(chunks, []);
});
