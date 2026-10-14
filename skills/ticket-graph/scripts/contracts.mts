import {
  Failure,
  configuration,
  initialize,
  history,
  check,
  list,
  update,
  withLock,
} from "./engine.mts";
import { s } from "./schema.mts";
import type { Infer } from "./schema.mts";
import type { Effects } from "./types.ts";
import {
  defineCli,
  helpCapability,
  outputCapability,
} from "./vendor/cli-contract.mjs";

const string = s.string();
const id = s.string({ pattern: "^[0-9]+$" });
const nonblank = s.string({ pattern: "\\S" });
const configField = {
  kind: "valueOption",
  longOption: "--config",
  description: "票集配置文件",
} as const;
const scope = s.object({ config: string, tickets: string });
const issue = s.object({
  code: string,
  message: string,
  ticket: string,
  file: string,
  key: string,
  field: s.optional(string),
  target: s.optional(string),
  reason: s.optional(string),
  offset: s.optional(s.number()),
  path: s.optional(s.array(string)),
});
const changeFields = {
  ticket: id,
  field: s.enum(["status", "blocked_by"]),
  before: s.optional(s.jsonValue()),
  after: s.union(string, s.array(id)),
  changed: s.boolean(),
  state: s.enum(["unchanged", "saved", "failed", "notExecuted"]),
  ticketSaved: s.boolean(),
  historySaved: s.union(s.boolean(), s.null()),
};
export const changeSchema = s.object(changeFields);
const effectSchema = s.object({
  configCreated: s.boolean(),
  configSaved: s.union(s.boolean(), s.null()),
  ticketSaved: s.optional(s.boolean()),
  historySaved: s.optional(s.union(s.boolean(), s.null())),
  ticket: s.optional(id),
  field: s.optional(s.enum(["status", "blocked_by"])),
  before: s.optional(s.jsonValue()),
  after: s.optional(s.jsonValue()),
  results: s.optional(s.array(changeSchema)),
});
export const failureSchema = s.object({
  error: s.object({
    code: string,
    message: string,
    file: s.optional(string),
    cause: s.optional(string),
    ticket: s.optional(id),
    target: s.optional(id),
    field: s.optional(string),
    files: s.optional(s.array(string)),
    line: s.optional(s.number()),
    scope: s.optional(scope),
    issues: s.optional(
      s.array(
        s.union(
          issue,
          s.object({ path: string, keyword: string, message: string }),
        ),
      ),
    ),
  }),
  effects: effectSchema,
});

export const inputs = {
  init: s.object({
    config: string,
    tickets: string,
    completionValues: s.array(string, { minItems: 1 }),
  }),
  check: s.object({ config: string }),
  list: s.object({
    config: string,
    filter: s.optional(s.enum(["all", "unblocked", "blocked"])),
  }),
  setStatus: s.object({
    config: string,
    tickets: s.array(id, { minItems: 1 }),
    status: nonblank,
  }),
  setDeps: s.exactlyOne(
    s.object({
      config: string,
      ticket: id,
      dependencies: s.optional(s.array(id, { minItems: 1 })),
      clear: s.optional(s.true()),
    }),
    ["dependencies", "clear"],
  ),
  history: s.object({ config: string, ticket: s.optional(id) }),
};

const commonUpdate = {
  scope,
  history: string,
  valid: s.boolean(),
  issues: s.array(issue),
};
export const outputs = {
  init: s.object({ scope, created: s.boolean() }),
  check: s.object({ scope, valid: s.boolean(), total: s.number() }),
  list: s.object({
    scope,
    filter: s.enum(["all", "unblocked", "blocked"]),
    total: s.number(),
    tickets: s.array(
      s.object({
        id,
        file: string,
        status: string,
        delivery_complete: s.boolean(),
        blocked_by: s.array(id),
        blocked_by_unfinished: s.array(id),
      }),
    ),
  }),
  setStatus: s.object({ ...commonUpdate, results: s.array(changeSchema) }),
  setDeps: s.object({ ...commonUpdate, ...changeFields }),
  history: s.object({
    scope: s.object({
      config: string,
      history: string,
      ticket: s.union(id, s.null()),
    }),
    events: s.array(
      s.object(
        {
          ticket: id,
          field: string,
          time: string,
          before: s.jsonValue(),
          after: s.jsonValue(),
        },
        { additionalProperties: true },
      ),
    ),
  }),
};

interface Dependencies {
  effects: Effects;
}
const define = defineCli<Dependencies>();
const failures = {
  rejected: {
    description: "执行失败及实际写入效果",
    schema: failureSchema,
    exitCode: 1,
  },
} as const;

async function attempt<T>(
  effects: Effects,
  action: () => T | Promise<T>,
): Promise<
  { ok: true; data: T } | { ok: false; data: Infer<typeof failureSchema> }
> {
  try {
    return { ok: true, data: await action() };
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    // 省略内部错误中不存在的可选信息，保留旧值的 JSON 类型。
    const data: unknown = JSON.parse(
      JSON.stringify({ error: error.details, effects }),
    );
    if (!failureSchema.accepts(data))
      throw new Error("执行错误不符合票图失败契约。", { cause: error });
    return { ok: false, data };
  }
}

const init = define.command("init")({
  kind: "command",
  parent: "ticketGraph",
  name: "init",
  description: "创建配置，不覆盖已有文件；创建后用 check 检查票图。",
  fields: {
    config: configField,
    tickets: {
      kind: "valueOption",
      longOption: "--tickets",
      description: "票目录，相对配置文件解析",
    },
    completionValues: {
      kind: "repeatableOption",
      longOption: "--completion-value",
      description: "项目完成值，可重复提供",
    },
  },
  input: inputs.init,
  success: {
    kind: "data",
    variants: {
      created: { description: "已创建配置", schema: outputs.init, exitCode: 0 },
    },
  },
  failures,
  async handler({ input, dependencies, outcome }) {
    const result = await attempt(dependencies.effects, () =>
      initialize(
        {
          config: input.config,
          tickets: input.tickets,
          "completion-value": input.completionValues,
        },
        dependencies.effects,
      ),
    );
    return result.ok
      ? outcome.data.created(result.data)
      : outcome.failure.rejected(result.data);
  },
});
const checkCommand = define.command("check")({
  kind: "command",
  parent: "ticketGraph",
  name: "check",
  description: "检查字段、引用、自依赖和环。",
  fields: { config: configField },
  input: inputs.check,
  success: {
    kind: "data",
    variants: {
      checked: {
        description: "票图检查结果",
        schema: outputs.check,
        exitCode: 0,
      },
    },
  },
  failures,
  async handler({ input, dependencies, outcome }) {
    const result = await attempt(dependencies.effects, () =>
      check(configuration(input.config)),
    );
    return result.ok
      ? outcome.data.checked(result.data)
      : outcome.failure.rejected(result.data);
  },
});
const listCommand = define.command("list")({
  kind: "command",
  parent: "ticketGraph",
  name: "list",
  description: "查询票，前置是否满足不代表实施顺序。",
  fields: {
    config: configField,
    filter: {
      kind: "valueOption",
      longOption: "--filter",
      description: "筛选方式，默认 all",
    },
  },
  input: inputs.list,
  success: {
    kind: "data",
    variants: {
      listed: {
        description: "票集查询结果",
        schema: outputs.list,
        exitCode: 0,
      },
    },
  },
  failures,
  async handler({ input, dependencies, outcome }) {
    const result = await attempt(dependencies.effects, () =>
      list(configuration(input.config), input.filter ?? "all"),
    );
    return result.ok
      ? outcome.data.listed(result.data)
      : outcome.failure.rejected(result.data);
  },
});
const setStatus = define.command("setStatus")({
  kind: "command",
  parent: "ticketGraph",
  name: "set-status",
  description: "将一张或多张票设为同一状态，先整批预检，再逐票保存。",
  fields: {
    config: configField,
    tickets: { kind: "variadicPositional", description: "票标识，保留前导零" },
    status: {
      kind: "valueOption",
      longOption: "--status",
      description: "整批目标状态，保留原值",
    },
  },
  input: inputs.setStatus,
  success: {
    kind: "data",
    variants: {
      updated: {
        description: "逐票状态修改结果",
        schema: outputs.setStatus,
        exitCode: 0,
      },
    },
  },
  failures,
  async handler({ input, dependencies, outcome }) {
    const result = await attempt(dependencies.effects, () => {
      const config = configuration(input.config);
      return withLock(config, () =>
        update(
          config,
          {
            field: "status",
            tickets: input.tickets,
            after: input.status,
          },
          dependencies.effects,
        ),
      );
    });
    return result.ok
      ? outcome.data.updated(result.data)
      : outcome.failure.rejected(result.data);
  },
});
const setDeps = define.command("setDeps")({
  kind: "command",
  parent: "ticketGraph",
  name: "set-deps",
  description: "替换依赖；前置票和 --clear 必须且只能提供一项。",
  fields: {
    config: configField,
    ticket: { kind: "positional", description: "目标票标识" },
    dependencies: { kind: "variadicPositional", description: "前置票标识" },
    clear: { kind: "flag", longOption: "--clear", description: "显式清空依赖" },
  },
  input: inputs.setDeps,
  success: {
    kind: "data",
    variants: {
      updated: {
        description: "依赖修改结果",
        schema: outputs.setDeps,
        exitCode: 0,
      },
    },
  },
  failures,
  async handler({ input, dependencies, outcome }) {
    const result = await attempt(dependencies.effects, async () => {
      const config = configuration(input.config);
      const { results, ...common } = await withLock(config, () =>
        update(
          config,
          {
            field: "blocked_by",
            ticket: input.ticket,
            after: input.dependencies ?? [],
          },
          dependencies.effects,
        ),
      );
      return { ...common, ...results[0]! };
    });
    return result.ok
      ? outcome.data.updated(result.data)
      : outcome.failure.rejected(result.data);
  },
});
const historyCommand = define.command("history")({
  kind: "command",
  parent: "ticketGraph",
  name: "history",
  description: "查询变更历史；历史不参与当前票图计算。",
  fields: {
    config: configField,
    ticket: {
      kind: "valueOption",
      longOption: "--ticket",
      description: "仅查询指定票",
    },
  },
  input: inputs.history,
  success: {
    kind: "data",
    variants: {
      listed: {
        description: "历史查询结果",
        schema: outputs.history,
        exitCode: 0,
      },
    },
  },
  failures,
  async handler({ input, dependencies, outcome }) {
    const result = await attempt(dependencies.effects, () =>
      history(configuration(input.config), input.ticket),
    );
    return result.ok
      ? outcome.data.listed(result.data)
      : outcome.failure.rejected(result.data);
  },
});

export const cli = define({
  root: "ticketGraph",
  usageFailureExitCode: 2,
  help: helpCapability({
    shortAlias: "-h",
    headings: {
      usage: "用法",
      commands: "命令",
      arguments: "参数",
      options: "选项",
    },
    wording: {
      commandPlaceholder: "命令",
      choices: "可选值：{choices}",
      default: "默认值：{value}",
    },
  }),
  output: outputCapability({ defaultFormat: "structured" }),
  commands: {
    ticketGraph: {
      kind: "rootGroup",
      name: "ticket-graph",
      description: "票图管理工具；各子命令通过 --config 选择票集。",
    },
    ...init,
    ...checkCommand,
    ...listCommand,
    ...setStatus,
    ...setDeps,
    ...historyCommand,
  },
});
