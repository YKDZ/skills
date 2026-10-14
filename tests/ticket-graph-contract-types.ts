import { inputs, outputs } from "../skills/ticket-graph/scripts/contracts.mts";
import type { Infer } from "../skills/ticket-graph/scripts/schema.mts";
import { defineCli } from "../skills/ticket-graph/scripts/vendor/cli-contract.mjs";
import type { FieldDefinitionsForInput } from "../skills/ticket-graph/scripts/vendor/cli-contract.mjs";

// 此函数仅由类型检查验证；指令失效也会使检查失败。
export function verifyContractTypes() {
  const define = defineCli();
  define.command("status")({
    kind: "command",
    parent: "root",
    name: "set-status",
    description: "状态修改",
    fields: {
      config: {
        kind: "valueOption",
        longOption: "--config",
        description: "配置",
      },
      tickets: { kind: "variadicPositional", description: "票标识" },
      status: {
        kind: "valueOption",
        longOption: "--status",
        description: "状态",
      },
    },
    input: inputs.setStatus,
    success: {
      kind: "data",
      variants: {
        updated: {
          description: "结果",
          schema: outputs.setStatus,
          exitCode: 0,
        },
      },
    },
    failures: {
      rejected: { description: "失败", schema: outputs.check, exitCode: 1 },
    },
    handler({ outcome }) {
      // @ts-expect-error 未声明的失败不能返回。
      outcome.failure.unknown({});
      // @ts-expect-error 逐票结果必须是数组。
      return outcome.data.updated({ results: "wrong" });
    },
  });
  // @ts-expect-error 不能遗漏输入模式要求的状态字段。
  const missing: FieldDefinitionsForInput<Infer<typeof inputs.setStatus>> = {
    config: {
      kind: "valueOption",
      longOption: "--config",
      description: "配置",
    },
    tickets: { kind: "variadicPositional", description: "票标识" },
  };
  void missing;
}
