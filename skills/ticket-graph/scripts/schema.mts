import type {
  ContractSchema,
  JsonObject,
  JsonValue,
} from "./vendor/cli-contract.mjs";

interface Problem {
  message: string;
  path: readonly (string | number)[];
}

export interface Schema<T> extends ContractSchema<T> {
  readonly json: JsonObject;
  readonly accepts: (value: unknown) => value is T;
  readonly problem: (value: unknown) => Problem | undefined;
}

interface OptionalSchema<T> {
  readonly optional: true;
  readonly schema: Schema<T>;
}

export type Infer<S> = S extends Schema<infer T> | OptionalSchema<infer T>
  ? T
  : never;
type Fields = Record<string, Schema<unknown> | OptionalSchema<unknown>>;
type ObjectValue<Shape extends Fields> = {
  [
    K in keyof Shape as Shape[K] extends OptionalSchema<unknown> ? never : K
  ]: Infer<Shape[K]>;
} & {
  [
    K in keyof Shape as Shape[K] extends OptionalSchema<unknown> ? K : never
  ]?: Infer<Shape[K]>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJson(
  value: unknown,
  ancestors = new Set<object>(),
): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!Array.isArray(value) && !isObject(value)) return false;
  if (ancestors.has(value) || Object.getOwnPropertySymbols(value).length > 0)
    return false;
  ancestors.add(value);
  const entries: unknown[] = Array.isArray(value)
    ? [...value]
    : Object.values(value);
  const valid = entries.every((entry) => isJson(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

function schema<T>(
  json: JsonObject,
  check: (value: unknown) => Problem | undefined,
): Schema<T> {
  const problem = (value: unknown) =>
    check(value) ??
    (isJson(value)
      ? undefined
      : { message: "应为可记录的 JSON 值。", path: [] });
  const accepts = (value: unknown): value is T => problem(value) === undefined;
  return {
    json,
    problem,
    accepts,
    "~standard": {
      version: 1,
      vendor: "ticket-graph",
      validate: (value) => {
        const issue = problem(value);
        return issue === undefined
          ? { value: value as T }
          : { issues: [issue] };
      },
      jsonSchema: {
        input: () => ({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          ...json,
        }),
        output: () => ({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          ...json,
        }),
      },
    },
  };
}

function primitive<T>(
  json: JsonObject,
  accepts: (value: unknown) => value is T,
  message: string,
): Schema<T> {
  return schema(json, (value) =>
    accepts(value) ? undefined : { message, path: [] },
  );
}

export const s = {
  string({ pattern }: { pattern?: string } = {}): Schema<string> {
    const expression =
      pattern === undefined ? undefined : new RegExp(pattern, "u");
    return primitive(
      { type: "string", ...(pattern === undefined ? {} : { pattern }) },
      (value): value is string =>
        typeof value === "string" && (expression?.test(value) ?? true),
      pattern === undefined
        ? "应为字符串。"
        : `应为符合模式 ${pattern} 的字符串。`,
    );
  },
  enum<const Values extends readonly [string, ...string[]]>(
    values: Values,
  ): Schema<Values[number]> {
    return primitive(
      { type: "string", enum: values },
      (value): value is Values[number] =>
        typeof value === "string" && values.some((entry) => entry === value),
      `应为以下值之一：${values.join("、")}。`,
    );
  },
  boolean: (): Schema<boolean> =>
    primitive(
      { type: "boolean" },
      (value): value is boolean => typeof value === "boolean",
      "应为布尔值。",
    ),
  true: (): Schema<true> =>
    primitive(
      { type: "boolean", const: true },
      (value): value is true => value === true,
      "应为 true。",
    ),
  number: (): Schema<number> =>
    primitive(
      { type: "number" },
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
      "应为有限数值。",
    ),
  null: (): Schema<null> =>
    primitive(
      { type: "null" },
      (value): value is null => value === null,
      "应为 null。",
    ),
  optional<T>(value: Schema<T>): OptionalSchema<T> {
    return { optional: true, schema: value };
  },
  array<T>(
    item: Schema<T>,
    { minItems }: { minItems?: number } = {},
  ): Schema<T[]> {
    return schema(
      {
        type: "array",
        items: item.json,
        ...(minItems === undefined ? {} : { minItems }),
      },
      (value) => {
        if (!Array.isArray(value)) return { message: "应为数组。", path: [] };
        if (value.length < (minItems ?? 0))
          return { message: `至少需要 ${minItems} 项。`, path: [] };
        for (const [index, entry] of value.entries()) {
          const issue = item.problem(entry);
          if (issue) return { ...issue, path: [index, ...issue.path] };
        }
        return undefined;
      },
    );
  },
  object<const Shape extends Fields>(
    shape: Shape,
    { additionalProperties = false }: { additionalProperties?: boolean } = {},
  ): Schema<ObjectValue<Shape>> {
    const entries = Object.entries(shape).map(([key, value]) => ({
      key,
      schema: "optional" in value ? value.schema : value,
      optional: "optional" in value,
    }));
    return schema(
      {
        type: "object",
        properties: Object.fromEntries(
          entries.map(({ key, schema }) => [key, schema.json]),
        ),
        required: entries
          .filter(({ optional }) => !optional)
          .map(({ key }) => key),
        additionalProperties,
      },
      (value) => {
        if (!isObject(value)) return { message: "应为对象。", path: [] };
        const extra = Object.keys(value).find(
          (key) => !Object.hasOwn(shape, key),
        );
        if (extra !== undefined && !additionalProperties)
          return { message: "不支持此字段。", path: [extra] };
        for (const { key, schema, optional } of entries) {
          if (!Object.hasOwn(value, key)) {
            if (!optional) return { message: "缺少必填字段。", path: [key] };
          } else {
            const issue = schema.problem(value[key]);
            if (issue) return { ...issue, path: [key, ...issue.path] };
          }
        }
        return undefined;
      },
    );
  },
  union<const Members extends readonly [Schema<unknown>, ...Schema<unknown>[]]>(
    ...members: Members
  ): Schema<Infer<Members[number]>> {
    return schema({ anyOf: members.map((member) => member.json) }, (value) =>
      members.some((member) => member.accepts(value))
        ? undefined
        : { message: "不符合任何允许的值类型。", path: [] },
    );
  },
  exactlyOne<T extends object>(
    base: Schema<T>,
    fields: readonly [keyof T & string, keyof T & string],
  ): Schema<T> {
    return schema(
      {
        ...base.json,
        oneOf: fields.map((field) => ({
          required: [field],
          not: { required: fields.filter((other) => other !== field) },
        })),
      },
      (value) => {
        const issue = base.problem(value);
        if (issue) return issue;
        return fields.filter((field) => Object.hasOwn(value as object, field))
          .length === 1
          ? undefined
          : {
              message: `必须且只能提供 ${fields.join("、")} 中的一项。`,
              path: [],
            };
      },
    );
  },
  jsonValue: (): Schema<JsonValue> =>
    primitive(
      {},
      (value): value is JsonValue => isJson(value),
      "应为可记录的 JSON 值。",
    ),
};
