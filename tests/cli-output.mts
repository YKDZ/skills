import type {
  JsonValue,
  Effects,
  Issue,
} from "../skills/ticket-graph/scripts/types.mts";

// 各测试按所调用命令断言这些外部结果；解析本身不承担运行时校验。
export interface TicketView {
  id: string;
  file: string;
  status: string;
  delivery_complete: boolean;
  blocked_by: string[];
  blocked_by_unfinished: string[];
}

export interface HistoryEvent {
  ticket: string;
  field: string;
  time: string;
  before: JsonValue;
  after: JsonValue;
}

export interface Success {
  ok: true;
  command: string;
  scope: Record<string, string | null>;
  tickets: TicketView[];
  events: HistoryEvent[];
  total: number;
  changed: boolean;
  valid: boolean;
  issues: Issue[];
  ticket: string;
  field: string;
  before: JsonValue;
  after: JsonValue;
  history: string;
  created: boolean;
}

export interface ErrorOutput {
  ok: false;
  error: {
    code: string;
    file: string;
    message: string;
    line: number;
    issues: (Omit<Partial<Issue>, "path"> & {
      path?: string | string[];
      keyword?: string;
    })[];
  };
  effects: Effects;
}

export function success(text: string): Success {
  return JSON.parse(text) as Success;
}

export function failure(text: string): ErrorOutput {
  return JSON.parse(text) as ErrorOutput;
}
