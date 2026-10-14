import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
) as { devDependencies: Record<string, string> };
const yamlPackage = require("yaml/package.json") as {
  name: string;
  version: string;
  license: string;
  homepage: string;
};
const esbuildPackage = require("esbuild/package.json") as {
  name: string;
  version: string;
};

for (const dependency of [yamlPackage, esbuildPackage]) {
  if (manifest.devDependencies[dependency.name] !== dependency.version) {
    throw new Error(`重新构建前，请先安装仓库固定版本的 ${dependency.name}。`);
  }
}

const contractDirectory = dirname(
  dirname(require.resolve("@ykdz/cli-contract")),
);
const contractPackage = JSON.parse(
  await readFile(join(contractDirectory, "package.json"), "utf8"),
) as { name: string; version: string; license: string; homepage: string };
if (manifest.devDependencies[contractPackage.name] !== contractPackage.version)
  throw new Error("请先安装仓库固定版本的契约库。");
const yamlDirectory = dirname(require.resolve("yaml/package.json"));
for (const dependency of [
  {
    name: "yaml",
    metadata: yamlPackage,
    directory: yamlDirectory,
    entry: `export { ${Object.keys(require("yaml")).sort().join(", ")} } from "yaml";`,
    repository: "https://github.com/eemeli/yaml",
    tarballName: "yaml",
  },
  {
    name: "cli-contract",
    metadata: contractPackage,
    directory: contractDirectory,
    entry:
      'export { defineCli, helpCapability, outputCapability, executeCli, parseCliInvocation, CliWriteError, text } from "@ykdz/cli-contract"; export { nodeCliOutput } from "@ykdz/cli-contract/node";',
    repository: "https://github.com/YKDZ/cli-contract",
    tarballName: "cli-contract",
  },
]) {
  const license = await readFile(join(dependency.directory, "LICENSE"), "utf8");
  const vendorDirectory =
    process.argv[2] ?? join(root, "skills/ticket-graph/scripts/vendor");
  const outputPath = join(vendorDirectory, `${dependency.name}.mjs`);
  const banner = [
    `由 esbuild@${esbuildPackage.version} 根据 ${dependency.metadata.name}@${dependency.metadata.version} 生成。`,
    "请勿手动修改此文件。重新构建：pnpm run build:ticket-graph-vendor",
    `来源与维护说明：${dependency.name}.SOURCE.json`,
    "",
    license.trimEnd(),
  ].join("\n");

  const result = await build({
    absWorkingDir: root,
    stdin: {
      contents: dependency.entry,
      resolveDir: root,
      sourcefile: `ticket-graph-${dependency.name}-entry.mjs`,
    },
    outfile: outputPath,
    bundle: true,
    minify: true,
    format: "esm",
    platform: "node",
    target: "node24.12",
    preserveSymlinks: true,
    legalComments: "inline",
    banner: {
      js:
        `/*\n${banner
          .split("\n")
          .map((line) => (line ? ` * ${line}` : " *"))
          .join("\n")}\n */\n` +
        "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
    },
    metafile: true,
    write: false,
  });

  for (const output of Object.values(result.metafile.outputs)) {
    if (output.imports.some((dependency) => !isBuiltin(dependency.path))) {
      throw new Error("随附依赖只能导入 Node.js 内置模块。");
    }
  }

  const source = {
    package: dependency.metadata.name,
    version: dependency.metadata.version,
    license: dependency.metadata.license,
    repository: dependency.repository,
    documentation: dependency.metadata.homepage,
    tarball: `https://registry.npmjs.org/${dependency.metadata.name}/-/${dependency.tarballName}-${dependency.metadata.version}.tgz`,
    generatedBy: `esbuild@${esbuildPackage.version}`,
    buildScript: "scripts/build-ticket-graph-vendor.ts",
    rebuildFromRepositoryRoot: [
      "pnpm install --frozen-lockfile --ignore-scripts",
      "pnpm run build:ticket-graph-vendor",
    ],
    dependencyVersionsAndIntegrity:
      "依赖版本与完整性校验信息由仓库根目录的 package.json 和 pnpm-lock.yaml 管理。",
    distribution:
      "复制完整技能目录即可离线使用。使用者只需 Node.js 24.12 及以上版本，无需安装依赖或构建。",
  };

  await mkdir(vendorDirectory, { recursive: true });
  await writeFile(outputPath, result.outputFiles[0]!.contents);
  await writeFile(join(vendorDirectory, `${dependency.name}.LICENSE`), license);
  await writeFile(
    join(vendorDirectory, `${dependency.name}.SOURCE.json`),
    `${JSON.stringify(source, null, 2)}\n`,
  );
}
