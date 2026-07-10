import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { schemaVersion, type GitTrailsDigest } from "./types.js";

export interface DigestValidationIssue {
  path: string;
  message: string;
  keyword: string;
  schemaPath: string;
}

export interface DigestValidationResult {
  ok: boolean;
  errors: DigestValidationIssue[];
}

let compiledDigestSchema: ValidateFunction | null = null;

export function validateDigest(value: unknown): DigestValidationResult {
  const validate = digestSchemaValidator();
  const ok = validate(value);
  return {
    ok,
    errors: ok ? [] : validationIssues(validate.errors ?? [])
  };
}

function digestSchemaValidator(): ValidateFunction {
  if (compiledDigestSchema !== null) {
    return compiledDigestSchema;
  }

  const schemaUrl = new URL(`../schema/${schemaVersion}.schema.json`, import.meta.url);
  const schema = JSON.parse(readFileSync(schemaUrl, "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  compiledDigestSchema = ajv.compile<GitTrailsDigest>(schema);
  return compiledDigestSchema;
}

function validationIssues(errors: ErrorObject[]): DigestValidationIssue[] {
  return errors.map((error) => ({
    path: error.instancePath === "" ? "/" : error.instancePath,
    message: error.message ?? "schema validation failed",
    keyword: error.keyword,
    schemaPath: error.schemaPath
  }));
}
