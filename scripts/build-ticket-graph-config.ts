import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv } from "ajv";
import standaloneCode from "ajv/dist/standalone/index.js";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
) as { devDependencies: Record<string, string> };
const ajvPackage = require("ajv/package.json") as {
  name: string;
  version: string;
  license: string;
};
const esbuildPackage = require("esbuild/package.json") as {
  name: string;
  version: string;
};

for (const dependency of [ajvPackage, esbuildPackage]) {
  if (manifest.devDependencies[dependency.name] !== dependency.version) {
    throw new Error(`重新构建前，请先安装仓库固定版本的 ${dependency.name}。`);
  }
}

const schemaPath = "skills/ticket-graph/ticket-graph.schema.json";
const schema = JSON.parse(await readFile(join(root, schemaPath), "utf8"));
const ajv = new Ajv({
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  code: { source: true, esm: true },
});
const validate = ajv.compile(schema);
const ajvDirectory = dirname(require.resolve("ajv/package.json"));
const license = await readFile(join(ajvDirectory, "LICENSE"), "utf8");
const vendorDirectory =
  process.argv[2] ?? join(root, "skills/ticket-graph/scripts/vendor");
const outputPath = join(vendorDirectory, "config-validator.mjs");
const banner = [
  `由 ajv@${ajvPackage.version} 与 esbuild@${esbuildPackage.version} 根据 ${schemaPath} 生成。`,
  "请勿手动修改此文件。重新构建：pnpm run build:ticket-graph-config",
  "来源与维护说明：config-validator.SOURCE.json",
  "",
  license.trimEnd(),
].join("\n");

const result = await build({
  absWorkingDir: root,
  stdin: {
    contents: standaloneCode.default(ajv, validate),
    resolveDir: root,
    sourcefile: "ticket-graph-config-validator.mjs",
  },
  outfile: outputPath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24.12",
  preserveSymlinks: true,
  legalComments: "inline",
  banner: {
    js: `/*\n${banner
      .split("\n")
      .map((line) => (line ? ` * ${line}` : " *"))
      .join("\n")}\n */`,
  },
  metafile: true,
  write: false,
});

for (const output of Object.values(result.metafile.outputs)) {
  if (output.imports.some((dependency) => !isBuiltin(dependency.path))) {
    throw new Error("随附的配置校验模块只能导入 Node.js 内置模块。");
  }
}

const source = {
  schema: schemaPath,
  package: ajvPackage.name,
  version: ajvPackage.version,
  license: ajvPackage.license,
  repository: "https://github.com/ajv-validator/ajv",
  documentation: "https://ajv.js.org/standalone.html",
  tarball: `https://registry.npmjs.org/ajv/-/ajv-${ajvPackage.version}.tgz`,
  generatedBy: `ajv@${ajvPackage.version} + esbuild@${esbuildPackage.version}`,
  buildScript: "scripts/build-ticket-graph-config.ts",
  rebuildFromRepositoryRoot: [
    "pnpm install --frozen-lockfile --ignore-scripts",
    "pnpm run build:ticket-graph-config",
  ],
  dependencyVersionsAndIntegrity:
    "依赖版本与完整性校验信息由仓库根目录的 package.json 和 pnpm-lock.yaml 管理。",
  distribution:
    "校验器及所需运行依赖已打包。复制完整技能目录即可离线使用；使用者只需 Node.js 24.12 及以上版本，无需安装依赖或构建。",
};

await mkdir(vendorDirectory, { recursive: true });
await writeFile(outputPath, result.outputFiles[0]!.contents);
await writeFile(
  join(vendorDirectory, "config-validator.LICENSE"),
  `${license.trimEnd()}\n`,
);
await writeFile(
  join(vendorDirectory, "config-validator.SOURCE.json"),
  `${JSON.stringify(source, null, 2)}\n`,
);
