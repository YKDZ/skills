import type { ValidateFunction } from "ajv";

import type { ProjectConfig } from "../types.mts";

declare const validateConfig: ValidateFunction<ProjectConfig>;
export default validateConfig;
