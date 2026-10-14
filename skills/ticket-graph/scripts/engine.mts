#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  statSync,
  appendFileSync,
  openSync,
  closeSync,
  realpathSync,
  readSync,
  fstatSync,
} from "node:fs";
import { dirname, resolve, join, relative, sep, isAbsolute } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { inspect, replaceValue } from "./graph.mts";
import type { Configuration, Effects, ChangeResult } from "./types.ts";
import validateConfig from "./vendor/config-validator.mjs";

type UpdateRequest =
  | { field: "status"; tickets: string[]; after: string }
  | { field: "blocked_by"; ticket: string; after: string[] };

class Failure extends Error {
  details: { code: string; message: string; [key: string]: unknown };

  constructor(
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.details = { code, message, ...details };
  }
}

function read(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    throw new Failure("READ_FAILED", "无法读取文件。", {
      file: path,
      cause: error.code,
    });
  }
}

function configuration(path: string) {
  const file = resolve(path);
  let value: unknown;
  try {
    value = JSON.parse(read(file));
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    if (error instanceof Failure) throw error;
    if (!(error instanceof SyntaxError)) throw error;
    throw new Failure("INVALID_CONFIG", "配置必须是有效 JSON。", { file });
  }
  return configValue(file, value);
}

function configValue(file: string, value: unknown): Configuration {
  if (!validateConfig(value)) {
    const issues = (validateConfig.errors ?? []).map(
      ({ instancePath, keyword, params }) => {
        const property = params.missingProperty ?? params.additionalProperty;
        const path =
          instancePath +
          (property === undefined
            ? ""
            : `/${property.replaceAll("~", "~0").replaceAll("/", "~1")}`);
        const types: Record<string, string> = {
          object: "对象",
          array: "数组",
          string: "字符串",
        };
        const messages: Record<string, string> = {
          required: "缺少必填字段。",
          additionalProperties: "不支持此配置字段。",
          type: `应为${types[params.type] ?? params.type}。`,
          pattern: "必须包含非空白字符。",
          minItems: "至少需要一个完成值。",
        };
        const message =
          path === "/completion/field"
            ? "状态字段已固定为 status，请移除 completion.field；旧票的其他状态字段须先迁移为 status。"
            : (messages[keyword] ?? "不符合配置结构定义。");
        return { path, keyword, message };
      },
    );
    throw new Failure("INVALID_CONFIG", "配置结构有误，请按字段位置修正。", {
      file,
      issues,
    });
  }
  return {
    file,
    directory: resolve(dirname(file), value.tickets),
    completion: value.completion,
    history: `${file}.history.jsonl`,
  };
}

function initialize(
  options: { config: string; tickets: string; "completion-value": string[] },
  effects: Effects,
) {
  const file = resolve(options.config);
  const schema = fileURLToPath(
    new URL("../ticket-graph.schema.json", import.meta.url),
  );
  const relativePath = relative(dirname(file), schema);
  const reference = isAbsolute(relativePath)
    ? pathToFileURL(schema).href
    : `./${relativePath.split(sep).map(encodeURIComponent).join("/")}`;
  const value = {
    $schema: reference,
    tickets: options.tickets,
    completion: { values: options["completion-value"] },
  };
  const config = configValue(file, value);
  let fd;
  try {
    fd = openSync(file, "wx");
    effects.configCreated = true;
    effects.configSaved = null;
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    effects.configSaved = true;
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    if (error.code === "EEXIST")
      throw new Failure("CONFIG_EXISTS", "配置已存在，未覆盖。", { file });
    throw new Failure(
      "WRITE_FAILED",
      "无法完成配置写入，请核对 effects 中的保存结果。",
      { file, cause: error.code },
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return {
    scope: { config: file, tickets: config.directory },
    created: true,
  };
}

function sources(config: Configuration) {
  let entries;
  try {
    entries = readdirSync(config.directory, { withFileTypes: true });
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    throw new Failure("READ_FAILED", "无法读取票目录。", {
      file: config.directory,
      cause: error.code,
    });
  }
  return entries
    .filter((entry) => /^\d+.*\.md$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const file = join(config.directory, entry.name);
      if (!entry.isFile())
        throw new Failure(
          "INVALID_TICKET_FILE",
          "票文件必须是普通文件，不能是目录或符号链接。",
          { file },
        );
      return { file, id: entry.name.match(/^\d+/)![0], text: read(file) };
    });
}

function recordDependencyEffects(effects: Effects, result: ChangeResult) {
  Object.assign(effects, {
    ticket: result.ticket,
    field: result.field,
    ...(result.before === undefined ? {} : { before: result.before }),
    after: result.after,
    ticketSaved: result.ticketSaved,
    historySaved: result.historySaved,
  });
}

function update(
  config: Configuration,
  change: UpdateRequest,
  effects: Effects,
) {
  const current = inspect(sources(config), config.completion);
  const { field, after } = change;
  const ids = [
    ...new Set(change.field === "status" ? change.tickets : [change.ticket]),
  ];
  const prepared = ids.map((id) => {
    const matches = current.tickets.filter((ticket) => ticket.id === id);
    if (matches.length !== 1)
      throw new Failure("INVALID_TARGET", "目标票不存在或标识重复。", {
        ticket: id,
        files: matches.map((ticket) => ticket.file),
      });
    const ticket = matches[0]!;
    const before = ticket.values[field];
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    let text = ticket.text;
    if (changed) {
      try {
        text = replaceValue(ticket, field, after);
      } catch (cause) {
        const error = cause as NodeJS.ErrnoException;
        if (error.code !== "UNEDITABLE_FIELD") throw error;
        throw new Failure(error.code, error.message, {
          ticket: id,
          file: ticket.file,
          field,
        });
      }
    }
    const result: ChangeResult = {
      ticket: id,
      field,
      ...(before === undefined ? {} : { before }),
      after,
      changed: false,
      state: changed ? "notExecuted" : "unchanged",
      ticketSaved: false,
      historySaved: false,
    };
    return { ticket, text, result, needsWrite: changed };
  });
  const replacements = new Map(
    prepared.map(({ ticket, text }) => [ticket.file, text]),
  );
  const candidate = inspect(
    current.tickets.map((ticket) => ({
      ...ticket,
      text: replacements.get(ticket.file) ?? ticket.text,
    })),
    config.completion,
  );
  const previous = new Set(
    current.issues
      .filter((issue) => issue.code !== "CYCLE")
      .map((issue) => issue.key),
  );
  const introduced = candidate.issues.filter(
    (issue) => issue.code !== "CYCLE" && !previous.has(issue.key),
  );
  const newCycle = [...candidate.cyclicEdges].some(
    (edge) => !current.cyclicEdges.has(edge),
  );
  if (introduced.length || newCycle)
    throw new Failure("INVALID_CHANGE", "修改会引入新的结构错误。", {
      issues: [
        ...introduced,
        ...(newCycle
          ? candidate.issues.filter((issue) => issue.code === "CYCLE")
          : []),
      ],
    });
  if (change.field === "blocked_by") {
    const pending = change.after.filter(
      (id) => !prepared[0]!.ticket.blocked_by?.includes(id),
    );
    const visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const matches = candidate.tickets.filter((ticket) => ticket.id === id);
      if (matches.length !== 1 || matches[0]!.blocked_by === null)
        throw new Failure(
          "UNVERIFIABLE_CHANGE",
          "新增依赖涉及无法确定前置关系的票，请先修复该票。",
          {
            ticket: ids[0],
            target: id,
            files: matches.map((ticket) => ticket.file),
          },
        );
      pending.push(...matches[0]!.blocked_by);
    }
  }
  const results = prepared.map(({ result }) => result);
  if (field === "status") {
    effects.results = results;
    delete effects.ticketSaved;
    delete effects.historySaved;
  } else recordDependencyEffects(effects, results[0]!);
  for (const { ticket, text, result, needsWrite } of prepared) {
    if (!needsWrite) continue;
    result.state = "failed";
    const temporary = join(
      dirname(ticket.file),
      `.ticket-graph-${randomUUID()}.tmp`,
    );
    let created = false;
    try {
      const fd = openSync(temporary, "wx", statSync(ticket.file).mode);
      created = true;
      try {
        writeFileSync(fd, text, "utf8");
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, ticket.file);
      created = false;
      result.ticketSaved = true;
      result.changed = true;
      if (field === "blocked_by") recordDependencyEffects(effects, result);
    } catch (cause) {
      const error = cause as NodeJS.ErrnoException;
      throw new Failure("WRITE_FAILED", "票文件未保存。", {
        file: ticket.file,
        cause: error.code,
      });
    } finally {
      if (created) unlinkSync(temporary);
    }
    try {
      const fd = openSync(config.history, "a+");
      try {
        const size = fstatSync(fd).size;
        const last = Buffer.alloc(1);
        if (size) readSync(fd, last, 0, 1, size - 1);
        const separator = size && last[0] !== 10 ? "\n" : "";
        const event = {
          ticket: ticket.id,
          field,
          time: new Date().toISOString(),
          before: result.before,
          after,
        };
        appendFileSync(fd, `${separator}${JSON.stringify(event)}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
      result.historySaved = true;
      result.state = "saved";
      if (field === "blocked_by") recordDependencyEffects(effects, result);
    } catch (cause) {
      const error = cause as NodeJS.ErrnoException;
      result.historySaved = null;
      if (field === "blocked_by") recordDependencyEffects(effects, result);
      throw new Failure(
        "HISTORY_WRITE_FAILED",
        "票已保存，无法确认历史完整写入。",
        { file: config.history, cause: error.code },
      );
    }
  }
  const common = {
    scope: { config: config.file, tickets: config.directory },
    history: config.history,
    valid: !candidate.issues.length,
    issues: candidate.issues,
  };
  return { ...common, results };
}

function history(config: Configuration, ticket: string | undefined) {
  let text;
  try {
    text = readFileSync(config.history, "utf8");
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    if (error.code === "ENOENT") text = "";
    else
      throw new Failure("READ_FAILED", "无法读取历史。", {
        file: config.history,
        cause: error.code,
      });
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const events = lines.map((line, index) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch (cause) {
      const error = cause as NodeJS.ErrnoException;
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (
      !event ||
      typeof event.ticket !== "string" ||
      !/^\d+$/.test(event.ticket) ||
      typeof event.field !== "string" ||
      !event.field ||
      typeof event.time !== "string" ||
      !Number.isFinite(Date.parse(event.time)) ||
      !Object.hasOwn(event, "before") ||
      !Object.hasOwn(event, "after")
    ) {
      throw new Failure("INVALID_HISTORY", "历史记录损坏。", {
        file: config.history,
        line: index + 1,
      });
    }
    return event;
  });
  return {
    scope: {
      config: config.file,
      history: config.history,
      ticket: ticket ?? null,
    },
    events: events.filter(
      (event) => ticket === undefined || event.ticket === ticket,
    ),
  };
}

async function withLock<T>(config: Configuration, action: () => T): Promise<T> {
  let directory;
  try {
    directory = realpathSync(config.directory);
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    throw new Failure("READ_FAILED", "无法读取票目录。", {
      file: config.directory,
      cause: error.code,
    });
  }
  const file = join(directory, ".ticket-graph.lock");
  const deadline = Date.now() + 5000;
  let fd;
  while (fd === undefined) {
    try {
      fd = openSync(file, "wx");
    } catch (cause) {
      const error = cause as NodeJS.ErrnoException;
      if (error.code !== "EEXIST")
        throw new Failure("LOCK_FAILED", "无法取得票集写入锁。", {
          file,
          cause: error.code,
        });
      if (Date.now() >= deadline)
        throw new Failure(
          "LOCKED",
          "票集写入锁仍被占用。若进程已异常退出，确认没有写入后清理锁文件。",
          { file },
        );
      await setTimeout(25);
    }
  }
  try {
    writeFileSync(
      fd,
      JSON.stringify({ pid: process.pid, time: new Date().toISOString() }),
    );
    closeSync(fd);
    fd = undefined;
    return action();
  } finally {
    if (fd !== undefined) closeSync(fd);
    unlinkSync(file);
  }
}

function checkedGraph(config: Configuration) {
  const ticket_graph = inspect(sources(config), config.completion);
  const scope = { config: config.file, tickets: config.directory };
  if (ticket_graph.issues.length)
    throw new Failure("INVALID_GRAPH", "票图有结构错误。", {
      issues: ticket_graph.issues,
      scope,
    });
  return { ticket_graph, scope };
}
function check(config: Configuration) {
  const { ticket_graph, scope } = checkedGraph(config);
  return { scope, valid: true, total: ticket_graph.tickets.length };
}
function list(config: Configuration, filter: "all" | "unblocked" | "blocked") {
  const { ticket_graph, scope } = checkedGraph(config);
  const tickets = ticket_graph.tickets.map(
    ({ id, file, status, delivery_complete, blocked_by }) => ({
      id,
      file,
      status: status!,
      delivery_complete,
      blocked_by: blocked_by!,
      blocked_by_unfinished: blocked_by!.filter(
        (id) =>
          !ticket_graph.tickets.find((other) => other.id === id)!
            .delivery_complete,
      ),
    }),
  );
  const selected = tickets.filter(
    (item) =>
      filter === "all" ||
      (!item.delivery_complete &&
        (filter === "blocked"
          ? item.blocked_by_unfinished.length > 0
          : !item.blocked_by_unfinished.length)),
  );
  return {
    scope,
    filter,
    total: tickets.length,
    tickets: selected,
  };
}
export {
  Failure,
  configuration,
  initialize,
  history,
  check,
  list,
  withLock,
  update,
};
