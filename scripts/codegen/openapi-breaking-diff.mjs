#!/usr/bin/env node
/**
 * OpenAPI breaking-change detector — SAD §16.2 (`contract-check.yml`).
 *
 * "CI diffs every PR against `main` and **fails on a breaking change** unless the
 * PR carries the `breaking-change-approved` label."
 *
 * WHY THIS IS HAND-WRITTEN AND DELIBERATELY NARROW. The industry tool here is
 * `oasdiff`, a Go binary. Using it would mean CI depends on a downloaded artefact
 * whose version is not in the lockfile, and pinning it is a supply-chain decision
 * (SAD §13) that has not been made. So this checks a small, explicit set of rules
 * and prints which ones it checked, rather than implying general coverage. A
 * detector that overstates its reach is worse than no detector, because reviewers
 * stop reading the spec diff.
 *
 * RULES (all conservative — only unambiguous breaks are reported):
 *   1. a path or method that existed on the base branch is gone
 *   2. a 2xx response status that existed is gone
 *   3. a property of a 2xx response object is gone
 *   4. a property's type changed
 *   5. an enum lost a value (a client sending it would now be rejected)
 *   6. an optional request input became required
 *
 * WHAT IT DOES NOT CHECK, on purpose: nested schema depth beyond one level,
 * `oneOf`/`anyOf` branch sets, discriminator changes, default values, header
 * semantics, or anything about descriptions. A spec change in those areas should
 * be caught by a human reading the `docs/api/OPENAPI.yaml` diff in the PR, which
 * is why that file is committed rather than generated at review time.
 *
 * Usage:
 *   node scripts/codegen/openapi-breaking-diff.mjs --base <base-spec> --head <head-spec>
 *
 * Exit codes: 0 = no breaking change (or no base to compare), 1 = breaking change.
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
];

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

const basePath = argValue("--base");
const headPath = argValue("--head", "docs/api/OPENAPI.yaml");

function loadSpec(path) {
  try {
    return parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Resolves a local `#/...` JSON pointer. Remote refs are out of scope by design. */
function resolvePointer(doc, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  return ref
    .slice(2)
    .split("/")
    .reduce(
      (node, key) =>
        node == null ? node : node[key.replace(/~1/g, "/").replace(/~0/g, "~")],
      doc,
    );
}

/** One level of `$ref` (and `allOf` merging) is enough for the rules above. */
function deref(doc, schema) {
  if (schema == null || typeof schema !== "object") return schema;
  if (schema.$ref) return deref(doc, resolvePointer(doc, schema.$ref));
  if (Array.isArray(schema.allOf)) {
    const merged = { type: "object", properties: {} };
    for (const part of schema.allOf) {
      const resolved = deref(doc, part) ?? {};
      Object.assign(merged.properties, resolved.properties ?? {});
      if (resolved.type) merged.type = resolved.type;
      if (resolved.enum) merged.enum = resolved.enum;
    }
    return merged;
  }
  return schema;
}

/** The JSON type a schema declares, treating `enum` without `type` as a string. */
function typeOf(doc, schema) {
  const resolved = deref(doc, schema) ?? {};
  if (resolved.type)
    return Array.isArray(resolved.type)
      ? [...resolved.type].sort().join("|")
      : resolved.type;
  if (resolved.enum) return "enum";
  if (resolved.properties || resolved.allOf) return "object";
  if (resolved.items) return "array";
  return undefined;
}

function enumValuesOf(doc, schema) {
  const resolved = deref(doc, schema) ?? {};
  return Array.isArray(resolved.enum) ? resolved.enum.map(String) : undefined;
}

const findings = [];
const record = (rule, detail) => findings.push({ rule, detail });

/** Rule 1: a path or method that existed on the base is gone. */
function comparePaths(base, head) {
  for (const [path, basePathItem] of Object.entries(base.paths ?? {})) {
    const headPathItem = head.paths?.[path];
    if (!headPathItem) {
      record("path-removed", `${path} is no longer documented`);
      continue;
    }
    for (const method of HTTP_METHODS) {
      const baseOp = basePathItem[method];
      if (!baseOp) continue;
      const headOp = headPathItem[method];
      if (!headOp) {
        record(
          "method-removed",
          `${method.toUpperCase()} ${path} is no longer documented`,
        );
        continue;
      }
      compareOperation(base, head, path, method, baseOp, headOp);
    }
  }
}

function compareOperation(baseDoc, headDoc, path, method, baseOp, headOp) {
  const where = `${method.toUpperCase()} ${path}`;

  // Rule 6: an optional input that became required.
  const baseInputs = inputRequiredness(baseDoc, baseOp);
  for (const [key, required] of inputRequiredness(headDoc, headOp)) {
    const wasRequired = baseInputs.get(key);
    if (wasRequired === false && required === true) {
      record(
        "input-became-required",
        `${where}: ${key} was optional and is now required`,
      );
    }
    if (wasRequired === undefined && required === true) {
      record(
        "required-input-added",
        `${where}: ${key} is required and did not exist before`,
      );
    }
  }

  // Rule 2: a successful status disappeared.
  const baseStatuses = Object.keys(baseOp.responses ?? {}).filter((s) =>
    /^2\d\d$/.test(s),
  );
  for (const status of baseStatuses) {
    if (!headOp.responses?.[status]) {
      record("response-removed", `${where}: ${status} response is gone`);
      continue;
    }
    compareResponseSchema(
      baseDoc,
      headDoc,
      where,
      status,
      baseOp.responses[status],
      headOp.responses[status],
    );
  }

  // Rule 5 for parameters: an enum that lost a value.
  const headParams = parameterMap(headDoc, headOp);
  for (const [key, baseParam] of parameterMap(baseDoc, baseOp)) {
    const headParam = headParams.get(key);
    if (!headParam) continue;
    const before = enumValuesOf(baseDoc, baseParam.schema);
    const after = enumValuesOf(headDoc, headParam.schema);
    if (before && after) {
      const lost = before.filter((value) => !after.includes(value));
      if (lost.length)
        record(
          "enum-narrowed",
          `${where}: parameter ${key} no longer accepts ${lost.join(", ")}`,
        );
    }
    const beforeType = typeOf(baseDoc, baseParam.schema);
    const afterType = typeOf(headDoc, headParam.schema);
    if (beforeType && afterType && beforeType !== afterType) {
      record(
        "type-changed",
        `${where}: parameter ${key} changed from ${beforeType} to ${afterType}`,
      );
    }
  }
}

function parameterMap(doc, operation) {
  const map = new Map();
  for (const param of operation.parameters ?? []) {
    const resolved = param.$ref ? deref(doc, param) : param;
    if (resolved?.name) map.set(`${resolved.in}.${resolved.name}`, resolved);
  }
  return map;
}

function inputRequiredness(doc, operation) {
  const map = new Map();
  for (const [key, param] of parameterMap(doc, operation))
    map.set(`parameter ${key}`, param.required === true);
  if (operation.requestBody || operation.requestBody?.$ref) {
    const body = deref(doc, operation.requestBody) ?? {};
    map.set("requestBody", body.required === true);
    for (const [name, schema] of Object.entries(
      deref(doc, body.content?.["application/json"]?.schema)?.properties ?? {},
    )) {
      map.set(
        `body.${name}`,
        (deref(doc, schema)?.required ?? false) === true ||
          isInRequiredList(doc, body, name),
      );
    }
  }
  return map;
}

function isInRequiredList(doc, body, name) {
  const schema = deref(doc, body.content?.["application/json"]?.schema) ?? {};
  return Array.isArray(schema.required) && schema.required.includes(name);
}

function compareResponseSchema(
  baseDoc,
  headDoc,
  where,
  status,
  baseResponse,
  headResponse,
) {
  const baseSchema = deref(
    baseDoc,
    baseResponse.content?.["application/json"]?.schema,
  );
  const headSchema = deref(
    headDoc,
    headResponse.content?.["application/json"]?.schema,
  );
  if (!baseSchema?.properties) return;

  if (!headSchema?.properties) {
    record(
      "response-schema-removed",
      `${where}: the ${status} response body is gone`,
    );
    return;
  }

  for (const [name, baseProp] of Object.entries(baseSchema.properties)) {
    const headProp = headSchema.properties[name];
    if (!headProp) {
      record(
        "response-property-removed",
        `${where} ${status}: response field "${name}" is gone`,
      );
      continue;
    }
    const beforeType = typeOf(baseDoc, baseProp);
    const afterType = typeOf(headDoc, headProp);
    if (beforeType && afterType && beforeType !== afterType) {
      record(
        "response-type-changed",
        `${where} ${status}: response field "${name}" changed from ${beforeType} to ${afterType}`,
      );
    }
    const beforeEnum = enumValuesOf(baseDoc, baseProp);
    const afterEnum = enumValuesOf(headDoc, headProp);
    if (beforeEnum && afterEnum) {
      const lost = beforeEnum.filter((value) => !afterEnum.includes(value));
      if (lost.length) {
        record(
          "response-enum-narrowed",
          `${where} ${status}: response field "${name}" no longer returns ${lost.join(", ")}`,
        );
      }
    }
  }
}

const head = loadSpec(headPath);
if (!head) {
  console.error(`contract-check: cannot read the head spec at ${headPath}`);
  process.exit(1);
}

const base = basePath ? loadSpec(basePath) : null;
if (!base) {
  // A missing base is not a pass — it means nothing was compared, and saying so
  // loudly is the difference between a gate and a decoration.
  console.log(
    basePath
      ? `contract-check: no spec at ${basePath} (new file on this branch) — nothing to compare.`
      : "contract-check: no --base given — nothing to compare.",
  );
  process.exit(0);
}

comparePaths(base, head);

if (findings.length === 0) {
  console.log(
    "contract-check: no breaking change detected against the base spec.",
  );
  console.log(
    "Checked: removed paths/methods, removed 2xx statuses, removed response fields, " +
      "response field type changes, enum narrowing, new or newly-required request inputs.",
  );
  process.exit(0);
}

console.error(
  `contract-check: ${findings.length} breaking change(s) detected.\n`,
);
for (const finding of findings)
  console.error(`  ✖ [${finding.rule}] ${finding.detail}`);
console.error(
  "\nIf this is intentional, add the `breaking-change-approved` label to the PR and state the " +
    "migration plan for shipped clients.",
);
process.exit(1);
