export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Completion {
  values: string[];
}

export interface ProjectConfig {
  $schema?: string;
  tickets: string;
  completion: Completion;
}

export interface Configuration {
  file: string;
  directory: string;
  completion: Completion;
  history: string;
}

export interface TicketSource {
  id: string;
  file: string;
  text: string;
}

export type Field = "status" | "blocked_by";

export interface ValueRange {
  start: number;
  end: number;
  prefix?: string;
  suffix?: string;
}

export interface Ticket extends TicketSource {
  status: string | null;
  delivery_complete: boolean;
  blocked_by: string[] | null;
  nodes: Partial<Record<Field, ValueRange>>;
  values: Partial<Record<Field, JsonValue>>;
}

export interface IssueDetails {
  field?: string;
  target?: string;
  reason?: string;
  offset?: number;
  path?: string[];
}

export interface Issue extends IssueDetails {
  code: string;
  message: string;
  ticket: string;
  file: string;
  key: string;
}

export interface Effects {
  configCreated: boolean;
  configSaved: boolean | null;
  ticketSaved?: boolean;
  historySaved?: boolean | null;
  results?: ChangeResult[];
  ticket?: string;
  field?: Field;
  before?: JsonValue;
  after?: JsonValue;
}

export interface ChangeResult {
  ticket: string;
  field: Field;
  before?: JsonValue;
  after: string | string[];
  changed: boolean;
  state: "unchanged" | "saved" | "failed" | "notExecuted";
  ticketSaved: boolean;
  historySaved: boolean | null;
}
