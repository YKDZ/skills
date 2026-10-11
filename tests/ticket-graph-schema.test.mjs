import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Ajv from 'ajv';

const cli = fileURLToPath(new URL('../skills/ticket-graph/scripts/ticket-graph.mjs', import.meta.url));

test('公开配置定义与命令对同一组项目配置判断一致并保留原值', t => {
  const schema = JSON.parse(readFileSync(new URL('../skills/ticket-graph/ticket-graph.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv({ allErrors: true }).compile(schema);
  const root = mkdtempSync(join(tmpdir(), 'ticket-graph-schema-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'issues'));
  mkdirSync(join(root, '票据'));
  const configPath = join(root, 'ticket-graph.json');
  const examples = [
    [true, { tickets: 'issues', completion: { values: ['resolved'] } }],
    [true, { tickets: join(root, '票据'), completion: { values: [' DONE ', 'done', 'done'] }, $schema: './rules.json' }],
    [true, { tickets: 'issues', completion: { values: ['done'] }, $schema: 'https://example.invalid/schema.json' }],
    [false, null],
    [false, []],
    [false, {}],
    [false, { completion: { values: ['resolved'] } }],
    [false, { tickets: 'issues' }],
    [false, { tickets: '', completion: { values: ['resolved'] } }],
    [false, { tickets: ' \t\n', completion: { values: ['resolved'] } }],
    [false, { tickets: 7, completion: { values: ['resolved'] } }],
    [false, { tickets: 'issues', completion: null }],
    [false, { tickets: 'issues', completion: [] }],
    [false, { tickets: 'issues', completion: {} }],
    [false, { tickets: 'issues', completion: { values: 'resolved' } }],
    [false, { tickets: 'issues', completion: { values: [] } }],
    [false, { tickets: 'issues', completion: { values: [''] } }],
    [false, { tickets: 'issues', completion: { values: ['\u3000\t'] } }],
    [false, { tickets: 'issues', completion: { values: ['resolved', 7] } }],
    [false, { tickets: 'issues', completion: { values: ['resolved'], field: 'status' } }],
    [false, { tickets: 'issues', completion: { values: ['resolved'], value: 'resolved' } }],
    [false, { tickets: 'issues', completion: { values: ['resolved'] }, ticket: 'other' }],
    [false, { tickets: 'issues', completion: { values: ['resolved'] }, $schema: 7 }],
  ];

  for (const [expected, config] of examples) {
    const original = JSON.stringify(config, null, 2) + '\n';
    const unchanged = structuredClone(config);
    assert.equal(validate(config), expected, JSON.stringify(config));
    assert.deepEqual(config, unchanged);
    writeFileSync(configPath, original);
    const result = spawnSync(process.execPath, [cli, '--config', configPath, 'check'], { encoding: 'utf8', cwd: tmpdir() });
    assert.ifError(result.error);
    assert.equal(result.status, expected ? 0 : 1, `${original}\n${result.stderr}`);
    if (expected) {
      assert.equal(result.stderr, '');
      assert.equal(JSON.parse(result.stdout).valid, true);
    } else {
      assert.equal(result.stdout, '');
      assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_CONFIG');
    }
    assert.equal(readFileSync(configPath, 'utf8'), original);
  }
});
