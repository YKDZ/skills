#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync, statSync, appendFileSync, openSync, closeSync, realpathSync, writeSync, readSync, fstatSync } from 'node:fs';
import { dirname, resolve, join, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { inspect, replaceValue } from './graph.mjs';
import validateConfig from './vendor/config-validator.mjs';

class Failure extends Error {
  constructor(code, message, details = {}, exitCode = 1) {
    super(message);
    this.details = { code, message, ...details };
    this.exitCode = exitCode;
  }
}

const commands = {
  init: 'init --tickets <目录> --completion-value <完成值>：创建配置；可重复提供完成值。',
  check: '检查字段、引用、自依赖和环。',
  list: '查询当前票；--filter all|unblocked|blocked 筛选结果，默认 all。',
  'set-status': 'set-status <票标识> <状态值>：修改票头的 status。',
  'set-deps': 'set-deps <票标识> <前置票>...：替换依赖；使用 --clear 显式清空。',
  history: '查询工具记录的变更；--ticket <票标识> 只查询指定票。',
};

function usage(message) { throw new Failure('USAGE', message, {}, 2); }
function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, tokens: true, options: {
      config: { type: 'string' }, help: { type: 'boolean', short: 'h' },
      filter: { type: 'string' }, ticket: { type: 'string' }, clear: { type: 'boolean' },
      tickets: { type: 'string' }, 'completion-value': { type: 'string', multiple: true },
    } });
  } catch (error) {
    if (!error.code?.startsWith('ERR_PARSE_ARGS')) throw error;
    throw new Failure('USAGE', '参数格式有误，请用 --help 查看选项及其取值。', { cause: error.code }, 2);
  }
  const { values, positionals: [command, ...args], tokens } = parsed;
  if (command && !Object.hasOwn(commands, command)) usage(`未知命令：${command}`);
  if (values.help) return { help: command || null };
  if (!command || !values.config) usage('需要命令和 --config <配置文件>，使用 --help 查看帮助。');
  const seen = new Set();
  for (const token of tokens.filter(token => token.kind === 'option')) {
    if (seen.has(token.name) && token.name !== 'completion-value') usage(`选项不能重复：--${token.name}`);
    seen.add(token.name);
  }
  for (const [option, allowed] of Object.entries({ filter: 'list', ticket: 'history', clear: 'set-deps', tickets: 'init', 'completion-value': 'init' })) {
    if (values[option] !== undefined && command !== allowed) usage(`--${option} 仅用于 ${allowed}。`);
  }
  if (values.filter !== undefined && !['all', 'unblocked', 'blocked'].includes(values.filter)) usage('筛选值应为 all、unblocked 或 blocked。');
  if (['init', 'check', 'list', 'history'].includes(command) && args.length) usage(`${command} 不接受位置参数。`);
  if (command === 'init' && (values.tickets === undefined || !values['completion-value']?.length)) usage('init 需要 --tickets <目录> 和至少一个 --completion-value <完成值>。');
  if (command === 'set-status' && (args.length !== 2 || !args[1].trim())) usage('set-status 需要票标识和非空状态值。');
  if (command === 'set-deps' && (values.clear ? args.length !== 1 : args.length < 2)) usage('set-deps 需要票标识和前置票；清空请使用 --clear。');
  const ids = command === 'set-status' ? args.slice(0, 1) : command === 'set-deps' ? args : values.ticket === undefined ? [] : [values.ticket];
  if (ids.some(id => !/^\d+$/.test(id))) usage('票标识必须是保留前导零的数字字符串。');
  return { command, args, ...values };
}

function help(command) {
  return `票图管理（Node.js 22 及以上）
用法：node ticket-graph.mjs --config <文件> <命令> [参数]
${command ? `${command}：${commands[command]}` : Object.entries(commands).map(([name, description]) => `  ${name}：${description}`).join('\n')}
根命令及各子命令均可用 --help；帮助不读取配置或票据。

配置示例（相对路径以配置所在目录为准）：
  {"tickets":"issues","completion":{"values":["resolved"]}}
每个票集使用一份配置，不自动查找或合并配置。
init 必须指定 --tickets 和至少一个 --completion-value；不会覆盖已有文件。
配置的父目录须已存在；init 不创建或检查票目录，不迁移票据，创建后用 check 检查票图。
配置可直接编辑，各命令共用校验；缺失、错类型及多余字段会报告文件和字段路径。
结构定义：${fileURLToPath(new URL('../ticket-graph.schema.json', import.meta.url))}
init 写入的 $schema 仅供编辑器使用，跨盘时用本地文件 URL；移动文件使引用失效后需更新，命令仍离线校验。
旧配置须移除 completion.field；票头的状态字段统一为 status，旧历史保留原字段名。
票目录只读取本层数字前缀的 .md 文件，不递归；数字前缀作为标识并保留前导零。
例如 01-任务.md：
  ---
  status: open
  blocked_by: ["02"]
  ---
  # 正文自由编写
文件头必须是 YAML 映射，两个机器字段必填。状态为非空字符串；完成值之外的值表示未完成。
blocked_by 为数字字符串数组，无依赖用 []。机器字段使用直接值，勿用锚点或别名。
正文中的字段不参与计算。首次接入需迁移旧字段，不维护两份当前元数据。

示例：
  node ticket-graph.mjs --config ticket-graph.json init --tickets issues --completion-value resolved
  node ticket-graph.mjs --config ticket-graph.json list --filter unblocked
  node ticket-graph.mjs --config ticket-graph.json set-status 01 resolved
  node ticket-graph.mjs --config ticket-graph.json set-deps 03 01 02
  node ticket-graph.mjs --config ticket-graph.json set-deps 03 --clear
  node ticket-graph.mjs --config ticket-graph.json history --ticket 01

unblocked/blocked 仅筛选未完成票，按直接前置票是否完成判定，不表示应该立即派发。
修改复用检查规则，拒绝新错误；可修复旧错误，并在结果中报告剩余问题。
并行命令内部串行写入。同票的正文编辑须与命令写入错开。
写入锁为票目录下的 .ticket-graph.lock，等待最多 5 秒。进程异常退出可能留下锁；
若报 LOCKED，确认其中记录的进程已退出且没有其他写入，再删除该锁文件。
历史路径为配置文件完整路径追加 .history.jsonl，例如 ticket-graph.json.history.jsonl。
各配置的历史独立，仅记录工具执行的变更。
配置、票文件与历史均留在项目中，历史不参与当前票图查询。
成功输出一个 JSON，退出 0；用法错误退出 2，其他预期失败退出 1，错误 JSON 写入标准错误。
查询无匹配项返回空数组及范围；查询失败不返回空结果。无变化时 changed 为 false。
失败可能发生在写入后，须核对 effects；configCreated 表示已创建配置文件，configSaved 表示已完整保存。
configSaved 为 null 表示写入结果不确定；票据修改查看 ticketSaved、historySaved 及实际值，不直接重试或回滚。
`;
}

function read(path) {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { throw new Failure('READ_FAILED', '无法读取文件。', { file: path, cause: error.code }); }
}

function configuration(path) {
  const file = resolve(path);
  let value;
  try { value = JSON.parse(read(file)); }
  catch (error) {
    if (error instanceof Failure) throw error;
    if (!(error instanceof SyntaxError)) throw error;
    throw new Failure('INVALID_CONFIG', '配置必须是有效 JSON。', { file });
  }
  return configValue(file, value);
}

function configValue(file, value) {
  if (!validateConfig(value)) {
    const issues = validateConfig.errors.map(({ instancePath, keyword, params }) => {
      const property = params.missingProperty ?? params.additionalProperty;
      const path = instancePath + (property === undefined ? '' : `/${property.replaceAll('~', '~0').replaceAll('/', '~1')}`);
      const types = { object: '对象', array: '数组', string: '字符串' };
      const messages = { required: '缺少必填字段。', additionalProperties: '不支持此配置字段。', type: `应为${types[params.type] ?? params.type}。`, pattern: '必须包含非空白字符。', minItems: '至少需要一个完成值。' };
      const message = path === '/completion/field'
        ? '状态字段已固定为 status，请移除 completion.field；旧票的其他状态字段须先迁移为 status。'
        : messages[keyword] ?? '不符合配置结构定义。';
      return { path, keyword, message };
    });
    throw new Failure('INVALID_CONFIG', '配置结构有误，请按字段位置修正。', { file, issues });
  }
  return { file, directory: resolve(dirname(file), value.tickets), completion: value.completion, history: `${file}.history.jsonl` };
}

function initialize(options, effects) {
  const file = resolve(options.config);
  const schema = fileURLToPath(new URL('../ticket-graph.schema.json', import.meta.url));
  const relativePath = relative(dirname(file), schema);
  const reference = isAbsolute(relativePath) ? pathToFileURL(schema).href : `./${relativePath.split(sep).map(encodeURIComponent).join('/')}`;
  const value = { $schema: reference, tickets: options.tickets, completion: { values: options['completion-value'] } };
  const config = configValue(file, value);
  let fd;
  try {
    fd = openSync(file, 'wx');
    effects.configCreated = true;
    effects.configSaved = null;
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    effects.configSaved = true;
  } catch (error) {
    if (error.code === 'EEXIST') throw new Failure('CONFIG_EXISTS', '配置已存在，未覆盖。', { file });
    throw new Failure('WRITE_FAILED', '无法完成配置写入，请核对 effects 中的保存结果。', { file, cause: error.code });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return { ok: true, command: 'init', scope: { config: file, tickets: config.directory }, created: true };
}

function sources(config) {
  let entries;
  try { entries = readdirSync(config.directory, { withFileTypes: true }); }
  catch (error) { throw new Failure('READ_FAILED', '无法读取票目录。', { file: config.directory, cause: error.code }); }
  return entries.filter(entry => /^\d+.*\.md$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
    const file = join(config.directory, entry.name);
    if (!entry.isFile()) throw new Failure('INVALID_TICKET_FILE', '票文件必须是普通文件，不能是目录或符号链接。', { file });
    return { file, id: entry.name.match(/^\d+/)[0], text: read(file) };
  });
}

function update(config, options, effects) {
  const current = inspect(sources(config), config.completion);
  const matches = current.tickets.filter(ticket => ticket.id === options.args[0]);
  if (matches.length !== 1) throw new Failure('INVALID_TARGET', '目标票不存在或标识重复。', { ticket: options.args[0], files: matches.map(ticket => ticket.file) });
  const ticket = matches[0];
  const field = options.command === 'set-status' ? 'status' : 'blocked_by';
  const before = ticket.values[field];
  const after = options.command === 'set-status' ? options.args[1] : options.clear ? [] : options.args.slice(1);
  Object.assign(effects, { ticket: ticket.id, field, before, after });
  const result = { ok: true, command: options.command, scope: { config: config.file, tickets: config.directory }, ticket: ticket.id, field, before, after, history: config.history };
  if (JSON.stringify(before) === JSON.stringify(after)) return { ...result, changed: false, valid: !current.issues.length, issues: current.issues };
  let text;
  try { text = replaceValue(ticket, field, after); }
  catch (error) {
    if (error.code !== 'UNEDITABLE_FIELD') throw error;
    throw new Failure(error.code, error.message, { ticket: ticket.id, file: ticket.file, field });
  }
  const candidate = inspect(current.tickets.map(item => ({ ...item, text: item.file === ticket.file ? text : item.text })), config.completion);
  const previous = new Set(current.issues.filter(issue => issue.code !== 'CYCLE').map(issue => issue.key));
  const introduced = candidate.issues.filter(issue => issue.code !== 'CYCLE' && !previous.has(issue.key));
  const newCycle = [...candidate.cyclicEdges].some(edge => !current.cyclicEdges.has(edge));
  if (introduced.length || newCycle) throw new Failure('INVALID_CHANGE', '修改会引入新的结构错误。', { issues: [...introduced, ...newCycle ? candidate.issues.filter(issue => issue.code === 'CYCLE') : []] });
  if (field === 'blocked_by') {
    const pending = after.filter(id => !ticket.blocked_by?.includes(id));
    const visited = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      const matches = candidate.tickets.filter(item => item.id === id);
      if (matches.length !== 1 || matches[0].blocked_by === null) {
        throw new Failure('UNVERIFIABLE_CHANGE', '新增依赖涉及无法确定前置关系的票，请先修复该票。', { ticket: ticket.id, target: id, files: matches.map(item => item.file) });
      }
      pending.push(...matches[0].blocked_by);
    }
  }
  const temporary = join(dirname(ticket.file), `.ticket-graph-${randomUUID()}.tmp`);
  let created = false;
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: statSync(ticket.file).mode });
    created = true;
    renameSync(temporary, ticket.file);
    created = false;
    effects.ticketSaved = true;
  } catch (error) {
    throw new Failure('WRITE_FAILED', '票文件未保存。', { file: ticket.file, cause: error.code });
  } finally {
    if (created) unlinkSync(temporary);
  }
  const event = { ticket: ticket.id, field, time: new Date().toISOString(), before, after };
  try {
    const fd = openSync(config.history, 'a+');
    try {
      const size = fstatSync(fd).size;
      const last = Buffer.alloc(1);
      if (size) readSync(fd, last, 0, 1, size - 1);
      const separator = size && last[0] !== 10 ? '\n' : '';
      appendFileSync(fd, `${separator}${JSON.stringify(event)}\n`, 'utf8');
    } finally { closeSync(fd); }
    effects.historySaved = true;
  } catch (error) {
    effects.historySaved = null;
    throw new Failure('HISTORY_WRITE_FAILED', '票已保存，无法确认历史完整写入。', { file: config.history, cause: error.code });
  }
  return { ...result, changed: true, valid: !candidate.issues.length, issues: candidate.issues };
}

function history(config, ticket) {
  let text;
  try { text = readFileSync(config.history, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') text = '';
    else throw new Failure('READ_FAILED', '无法读取历史。', { file: config.history, cause: error.code });
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const events = lines.map((line, index) => {
    let event;
    try { event = JSON.parse(line); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (!event || typeof event.ticket !== 'string' || !/^\d+$/.test(event.ticket)
      || typeof event.field !== 'string' || !event.field || typeof event.time !== 'string'
      || !Number.isFinite(Date.parse(event.time)) || !Object.hasOwn(event, 'before') || !Object.hasOwn(event, 'after')) {
      throw new Failure('INVALID_HISTORY', '历史记录损坏。', { file: config.history, line: index + 1 });
    }
    return event;
  });
  return { ok: true, command: 'history', scope: { config: config.file, history: config.history, ticket: ticket ?? null }, events: events.filter(event => ticket === undefined || event.ticket === ticket) };
}

async function withLock(config, action) {
  let directory;
  try { directory = realpathSync(config.directory); }
  catch (error) { throw new Failure('READ_FAILED', '无法读取票目录。', { file: config.directory, cause: error.code }); }
  const file = join(directory, '.ticket-graph.lock');
  const deadline = Date.now() + 5000;
  let fd;
  while (fd === undefined) {
    try { fd = openSync(file, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw new Failure('LOCK_FAILED', '无法取得票集写入锁。', { file, cause: error.code });
      if (Date.now() >= deadline) throw new Failure('LOCKED', '票集写入锁仍被占用。若进程已异常退出，确认没有写入后清理锁文件。', { file });
      await setTimeout(25);
    }
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
    closeSync(fd);
    fd = undefined;
    return action();
  } finally {
    if (fd !== undefined) closeSync(fd);
    unlinkSync(file);
  }
}

async function main(options, effects) {
  if (Object.hasOwn(options, 'help')) return help(options.help);
  if (options.command === 'init') return initialize(options, effects);
  const config = configuration(options.config);
  if (options.command === 'history') return history(config, options.ticket);
  if (options.command.startsWith('set-')) return withLock(config, () => update(config, options, effects));
  const ticket_graph = inspect(sources(config), config.completion);
  const scope = { config: config.file, tickets: config.directory };
  if (ticket_graph.issues.length) throw new Failure('INVALID_GRAPH', '票图有结构错误。', { issues: ticket_graph.issues, scope });
  if (options.command === 'check') return { ok: true, command: 'check', scope, valid: true, total: ticket_graph.tickets.length };
  const tickets = ticket_graph.tickets.map(({ id, file, status, delivery_complete, blocked_by }) => ({
    id, file, status, delivery_complete, blocked_by,
    blocked_by_unfinished: blocked_by.filter(id => !ticket_graph.tickets.find(other => other.id === id).delivery_complete),
  }));
  const filter = options.filter || 'all';
  const selected = tickets.filter(item => filter === 'all' || (!item.delivery_complete && (filter === 'blocked' ? item.blocked_by_unfinished.length > 0 : !item.blocked_by_unfinished.length)));
  return { ok: true, command: options.command, scope, filter, total: tickets.length, tickets: selected };
}

const effects = { configCreated: false, configSaved: false, ticketSaved: false, historySaved: false };
function output(fd, text) {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}
try {
  const result = await main(parse(process.argv.slice(2)), effects);
  try { output(1, typeof result === 'string' ? result : `${JSON.stringify(result)}\n`); }
  catch (error) { throw new Failure('OUTPUT_FAILED', '结果未完整输出；已发生的修改仍然有效。', { cause: error.code }); }
} catch (error) {
  process.exitCode = error instanceof Failure ? error.exitCode : 1;
  const details = error instanceof Failure ? error.details : { code: 'INTERNAL_ERROR', message: error.message, stack: error.stack };
  try { output(2, `${JSON.stringify({ ok: false, error: details, effects })}\n`); }
  catch { /* 标准错误也不可写时，只能保留失败退出码。 */ }
}
