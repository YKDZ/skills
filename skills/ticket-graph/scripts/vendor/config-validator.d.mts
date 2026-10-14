import type { ValidateFunction } from "ajv";

import type { ProjectConfig } from "../types.ts";

declare const validateConfig: ValidateFunction<ProjectConfig>;
export default validateConfig;
