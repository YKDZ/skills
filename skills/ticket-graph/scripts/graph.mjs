import { isAlias, isMap, isScalar, isSeq, parseDocument } from './vendor/yaml.mjs';

export function inspect(sources, completion) {
  const issues = [];
  const tickets = sources.map(source => {
    const empty = { ...source, status: null, delivery_complete: false, blocked_by: null, nodes: Object.create(null), values: Object.create(null) };
    const opening = /^\uFEFF?---[ \t]*\r?\n/.exec(source.text);
    if (!opening) {
      issues.push(issue(source, 'MISSING_FRONTMATTER', '票文件首部缺少 YAML 文件头。'));
      return empty;
    }
    const offset = opening[0].length;
    const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(source.text.slice(offset));
    if (!closing) {
      issues.push(issue(source, 'UNCLOSED_FRONTMATTER', 'YAML 文件头缺少结束分隔行。'));
      return empty;
    }
    const document = parseDocument(source.text.slice(offset, offset + closing.index), { keepSourceTokens: true, prettyErrors: false });
    const duplicates = new Set();
    for (const error of document.errors) {
      const field = fieldAt(document.contents, error.pos[0]);
      if (error.code === 'DUPLICATE_KEY') {
        duplicates.add(field);
        issues.push(issue(source, 'DUPLICATE_FIELD', `YAML 字段 ${field} 重复。`, { field, offset: offset + error.pos[0] }));
      } else {
        issues.push(issue(source, 'INVALID_YAML', `YAML 文件头损坏：${error.code}。`, { field, offset: offset + error.pos[0], reason: error.code }));
      }
    }
    if (document.errors.some(error => error.code !== 'DUPLICATE_KEY')) {
      return empty;
    }
    if (!isMap(document.contents)) {
      issues.push(issue(source, 'INVALID_FRONTMATTER', 'YAML 文件头必须是映射。'));
      return empty;
    }
    let status = null;
    let blocked_by = null;
    const nodes = Object.create(null);
    const values = Object.create(null);
    for (const field of [completion.field, 'blocked_by']) {
      if (duplicates.has(field)) continue;
      const node = document.get(field, true);
      if (!node) {
        issues.push(issue(source, 'MISSING_FIELD', `缺少必需字段 ${field}。`, { field }));
        continue;
      }
      if (hasIndirectValue(node)) {
        issues.push(issue(source, 'UNSAFE_FIELD', `字段 ${field} 使用锚点、别名或标签，无法单独安全修改。`, { field }));
        continue;
      }
      if (!canRecordValue(node)) {
        issues.push(issue(source, 'UNSAFE_FIELD', `字段 ${field} 的旧值无法被 JSON 历史完整记录。`, { field }));
        continue;
      }
      const value = node.toJSON() ?? null;
      values[field] = value;
      nodes[field] = { start: offset + node.range[0], end: offset + node.range[1] };
      if (node.range[0] === node.range[1] && source.text[offset + node.range[0] - 1] === ':') nodes[field].prefix = ' ';
      if (node.srcToken?.type === 'block-scalar') {
        const range = nodes[field];
        range.suffix = node.srcToken.props.slice(1).filter(token => token.type !== 'newline').map(token => token.source).join('');
      }
      if (node.srcToken?.type === 'block-seq') {
        nodes[field].end = offset + blockValueEnd(node);
        nodes[field].prefix = node.srcToken.indent === 0 ? '  ' : '';
      }
      if (node.srcToken?.type === 'block-map') nodes[field].end = offset + blockValueEnd(node);
      if (['block-scalar', 'block-seq', 'block-map'].includes(node.srcToken?.type)) {
        const range = nodes[field];
        const trailing = /(?:\r?\n)+$/.exec(source.text.slice(range.start, range.end));
        if (trailing) range.end -= trailing[0].length;
      }
      if (field === completion.field) {
        if (isScalar(node) && typeof node.value === 'string' && node.value.trim()) status = node.value;
        else issues.push(issue(source, 'INVALID_FIELD', `字段 ${field} 必须是非空字符串。`, { field }));
      } else if (isSeq(node) && node.items.every(item => isScalar(item) && typeof item.value === 'string' && /^\d+$/.test(item.value))) {
        blocked_by = node.items.map(item => item.value);
      } else {
        issues.push(issue(source, 'INVALID_FIELD', `字段 ${field} 必须是票标识字符串数组。`, { field }));
      }
    }
    return { ...source, status, delivery_complete: completion.values.includes(status), blocked_by, nodes, values };
  });
  const byId = new Map();
  for (const ticket of tickets) {
    if (!byId.has(ticket.id)) byId.set(ticket.id, []);
    byId.get(ticket.id).push(ticket);
  }
  for (const matches of byId.values()) {
    if (matches.length > 1) {
      for (const ticket of matches) issues.push(issue(ticket, 'DUPLICATE_ID', `票标识 ${ticket.id} 对应多个文件。`));
    }
  }
  for (const ticket of tickets) {
    if (ticket.blocked_by === null) continue;
    for (const target of new Set(ticket.blocked_by)) {
      if (target === ticket.id) {
        issues.push(issue(ticket, 'SELF_DEPENDENCY', `票 ${ticket.id} 依赖自身。`, { field: 'blocked_by', target }));
      } else if (!byId.has(target)) {
        issues.push(issue(ticket, 'MISSING_REFERENCE', `票 ${ticket.id} 的前置票 ${target} 不存在。`, { field: 'blocked_by', target }));
      }
    }
  }
  const adjacency = new Map();
  for (const ticket of tickets) {
    if (byId.get(ticket.id).length !== 1 || ticket.blocked_by === null) continue;
    adjacency.set(ticket.id, [...new Set(ticket.blocked_by)].filter(target => byId.get(target)?.length === 1));
  }
  const cyclicEdges = new Set();
  for (const component of strongComponents(adjacency)) {
    const members = new Set(component);
    for (const source of component) {
      for (const target of adjacency.get(source) ?? []) {
        if (members.has(target)) cyclicEdges.add(JSON.stringify([source, target]));
      }
    }
    if (component.length < 2) continue;
    const path = cyclePath(component, adjacency);
    const source = byId.get(path[0])[0];
    const problem = issue(source, 'CYCLE', `依赖形成环：${path.join(' → ')}。`, { field: 'blocked_by', path });
    problem.key = JSON.stringify(['CYCLE', component]);
    issues.push(problem);
  }
  return { tickets, issues, cyclicEdges };
}

function blockValueEnd(node) {
  if (node?.srcToken?.type === 'block-seq') return blockValueEnd(node.items.at(-1)) ?? node.range?.[1];
  if (node?.srcToken?.type === 'block-map') {
    const pair = node.items.at(-1);
    if (pair?.value) return blockValueEnd(pair.value) ?? node.range?.[1];
  }
  return node?.range?.[1];
}

function canRecordValue(node) {
  if (node === null) return true;
  if (isSeq(node)) return node.items.every(canRecordValue);
  if (isMap(node)) return node.items.every(pair => isScalar(pair.key) && typeof pair.key.value === 'string' && canRecordValue(pair.value));
  if (!isScalar(node)) return false;
  const value = node.value ?? null;
  if (typeof value === 'number') return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  return value === null || typeof value === 'string' || typeof value === 'boolean';
}

function hasIndirectValue(node) {
  if (!node) return false;
  if (isAlias(node) || node.anchor || node.tag) return true;
  if (isSeq(node)) return node.items.some(hasIndirectValue);
  if (isMap(node)) return node.items.some(pair => hasIndirectValue(pair.key) || hasIndirectValue(pair.value));
  return false;
}

function strongComponents(adjacency) {
  const indices = new Map();
  const lows = new Map();
  const stack = [];
  const active = new Set();
  const components = [];
  let nextIndex = 0;
  function visit(source) {
    indices.set(source, nextIndex);
    lows.set(source, nextIndex++);
    stack.push(source);
    active.add(source);
    for (const target of adjacency.get(source) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lows.set(source, Math.min(lows.get(source), lows.get(target)));
      } else if (active.has(target)) {
        lows.set(source, Math.min(lows.get(source), indices.get(target)));
      }
    }
    if (lows.get(source) !== indices.get(source)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      active.delete(member);
      component.push(member);
    } while (member !== source);
    components.push(component.sort());
  }
  for (const source of adjacency.keys()) if (!indices.has(source)) visit(source);
  return components;
}

function cyclePath(component, adjacency) {
  const start = component[0];
  const members = new Set(component);
  const previous = new Map([[start, null]]);
  const queue = [start];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const source = queue[cursor];
    for (const target of adjacency.get(source) ?? []) {
      if (!members.has(target) || target === source) continue;
      if (target === start) {
        const path = [source];
        let current = source;
        while (previous.get(current) !== null) {
          current = previous.get(current);
          path.push(current);
        }
        return [...path.reverse(), start];
      }
      if (!previous.has(target)) {
        previous.set(target, source);
        queue.push(target);
      }
    }
  }
}

function fieldAt(node, offset, path = []) {
  if (isMap(node)) {
    for (const pair of node.items) {
      const nextPath = [...path, String(pair.key?.value ?? '?')];
      if (pair.key?.range && offset >= pair.key.range[0] && offset < pair.key.range[1]) return nextPath.join('.');
      if (pair.value?.range && offset >= pair.value.range[0] && offset < pair.value.range[2]) return fieldAt(pair.value, offset, nextPath) ?? nextPath.join('.');
    }
  } else if (isSeq(node)) {
    for (const [index, item] of node.items.entries()) {
      if (item?.range && offset >= item.range[0] && offset < item.range[2]) return fieldAt(item, offset, [...path, index]);
    }
  }
  return path.length ? path.join('.') : undefined;
}

function issue(source, code, message, details = {}) {
  return { code, message, ticket: source.id, file: source.file, ...details, key: JSON.stringify([code, source.file, source.id, details.field ?? null, details.target ?? null, details.reason ?? null]) };
}

export function replaceValue(ticket, field, value) {
  const node = ticket.nodes[field];
  if (!node || !Number.isInteger(node.start) || !Number.isInteger(node.end) || node.start < 0 || node.end < node.start || node.end > ticket.text.length) {
    throw Object.assign(new Error(`无法安全修改字段 ${field}。`), { code: 'UNEDITABLE_FIELD', ticket: ticket.id, file: ticket.file, field });
  }
  return ticket.text.slice(0, node.start) + (node.prefix ?? '') + JSON.stringify(value) + (node.suffix ?? '') + ticket.text.slice(node.end);
}
