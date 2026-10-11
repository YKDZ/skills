import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const yamlPackage = require('yaml/package.json');
const esbuildPackage = require('esbuild/package.json');

for (const dependency of [yamlPackage, esbuildPackage]) {
  if (manifest.devDependencies[dependency.name] !== dependency.version) {
    throw new Error(`重新构建前，请先安装仓库固定版本的 ${dependency.name}。`);
  }
}

const yamlDirectory = dirname(require.resolve('yaml/package.json'));
const license = await readFile(join(yamlDirectory, 'LICENSE'), 'utf8');
const vendorDirectory = join(root, 'skills/ticket-graph/scripts/vendor');
const outputPath = join(vendorDirectory, 'yaml.mjs');
const exportNames = Object.keys(require('yaml')).sort();
const banner = [
  `由 esbuild@${esbuildPackage.version} 根据 yaml@${yamlPackage.version} 生成。`,
  '请勿手动修改此文件。重新构建：pnpm run build:ticket-graph-vendor',
  '来源与维护说明：yaml.SOURCE.json',
  '',
  license.trimEnd(),
].join('\n');

const result = await build({
  absWorkingDir: root,
  stdin: {
    contents: `export { ${exportNames.join(', ')} } from 'yaml';\n`,
    resolveDir: root,
    sourcefile: 'ticket-graph-yaml-entry.mjs',
  },
  outfile: outputPath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  preserveSymlinks: true,
  legalComments: 'inline',
  banner: {
    js: `/*\n${banner.split('\n').map(line => line ? ` * ${line}` : ' *').join('\n')}\n */\n`
      + "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
  metafile: true,
  write: false,
});

for (const output of Object.values(result.metafile.outputs)) {
  if (output.imports.some(dependency => !isBuiltin(dependency.path))) {
    throw new Error('随附的 YAML 模块只能导入 Node.js 内置模块。');
  }
}

const source = {
  package: yamlPackage.name,
  version: yamlPackage.version,
  license: yamlPackage.license,
  repository: 'https://github.com/eemeli/yaml',
  documentation: yamlPackage.homepage,
  tarball: `https://registry.npmjs.org/yaml/-/yaml-${yamlPackage.version}.tgz`,
  generatedBy: `esbuild@${esbuildPackage.version}`,
  buildScript: 'scripts/build-ticket-graph-vendor.mjs',
  rebuildFromRepositoryRoot: [
    'pnpm install --frozen-lockfile --ignore-scripts',
    'pnpm run build:ticket-graph-vendor',
  ],
  dependencyVersionsAndIntegrity: '依赖版本与完整性校验信息由仓库根目录的 package.json 和 pnpm-lock.yaml 管理。',
  distribution: '复制技能目录即可使用。使用者只需 Node.js，无需安装依赖或构建。',
};

await mkdir(vendorDirectory, { recursive: true });
await writeFile(outputPath, result.outputFiles[0].contents);
await writeFile(join(vendorDirectory, 'yaml.LICENSE'), license);
await writeFile(join(vendorDirectory, 'yaml.SOURCE.json'), `${JSON.stringify(source, null, 2)}\n`);
