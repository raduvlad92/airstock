/**
 * Writes the OpenAPI 3.1 contract from the operation registry, one file per operation, so
 * branches that add or change different operations never edit the same file:
 *
 *   docs/api/document.json             the document without `paths`
 *   docs/api/operations/<id>.json      one entry of `paths` per operation, by operation ID
 *
 * scripts/openapi-bundle.mjs joins them into the single document the Worker serves at
 * /openapi.json. `--check` fails when a file is stale, missing, or not generated.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AnyOperation, operations } from '@airstock/core';
import { z } from 'zod';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const API_DIR = join(ROOT, 'docs/api');
const OPERATIONS_DIR = join(API_DIR, 'operations');

function jsonSchema(schema: z.ZodType, io: 'input' | 'output') {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io,
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  return rest;
}

function pathParams(op: AnyOperation): string[] {
  return [...op.http.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
}

function operationObject(op: AnyOperation) {
  const params = pathParams(op);
  const inputParams = params.filter((p) => p !== 'shopId');
  const parameters: unknown[] = params.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  }));
  const bodySchema = op.input.omit(Object.fromEntries(inputParams.map((p) => [p, true])));
  let requestBody: unknown;
  if (op.http.method === 'GET') {
    const schema = jsonSchema(bodySchema, 'input') as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    for (const [name, prop] of Object.entries(schema.properties ?? {})) {
      parameters.push({
        name,
        in: 'query',
        required: schema.required?.includes(name) ?? false,
        schema: prop,
      });
    }
  } else if (Object.keys(bodySchema.shape).length > 0) {
    requestBody = {
      required: true,
      content: { 'application/json': { schema: jsonSchema(bodySchema, 'input') } },
    };
  }
  if (op.idempotency === 'required') {
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      description:
        'Unique per command. Retrying with the same key within 7 days returns the original result without repeating the effect. After 7 days the key is forgotten, and a request with it runs as a new one.',
      schema: { type: 'string', maxLength: 200 },
    });
  }
  const status = String(op.http.status ?? 200);
  return {
    operationId: op.id,
    summary: op.summary,
    ...(op.description ? { description: op.description } : {}),
    'x-permission': op.permission,
    'x-connection-scope': op.connectionScope,
    'x-audit-action': op.audit.action,
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses: {
      [status]: {
        description: 'Success',
        content: { 'application/json': { schema: jsonSchema(op.output, 'output') } },
      },
      default: { $ref: '#/components/responses/Problem' },
    },
  };
}

const document = {
  openapi: '3.1.0',
  info: {
    title: 'Airstock API',
    version: '0.1.0',
    description:
      'Generated from the operation registry (packages/core). Every operation is also reachable over MCP or has a documented exception. Errors use RFC 9457 problem details.',
  },
  servers: [{ url: 'https://airstock-staging.workers.dev' }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'API credential token (ask_...).',
      },
    },
    responses: {
      Problem: {
        description: 'Problem details (RFC 9457).',
        content: {
          'application/problem+json': {
            schema: {
              type: 'object',
              required: ['type', 'title', 'status', 'code'],
              properties: {
                type: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'integer' },
                code: { type: 'string' },
                detail: { type: 'string' },
                requestId: { type: 'string' },
                errors: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { path: { type: 'string' }, message: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const toText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Every generated file, by path relative to docs/api. */
const expected = new Map<string, string>([['document.json', toText(document)]]);
for (const op of operations) {
  const entry = {
    [`/api/v1${op.http.path}`]: { [op.http.method.toLowerCase()]: operationObject(op) },
  };
  expected.set(`operations/${op.id}.json`, toText(entry));
}

/** JSON files now in docs/api; the README and anything else is left alone. */
const entries = await readdir(API_DIR, { recursive: true, withFileTypes: true }).catch(() => []);
const present = entries
  .filter((e) => e.isFile() && e.name.endsWith('.json'))
  .map((e) => relative(API_DIR, join(e.parentPath, e.name)));
if (process.argv.includes('--check')) {
  const problems: string[] = [];
  for (const [file, text] of expected) {
    const current = await readFile(join(API_DIR, file), 'utf8').catch(() => null);
    if (current === null) problems.push(`missing ${file}`);
    else if (current !== text) problems.push(`stale ${file}`);
  }
  for (const file of present) if (!expected.has(file)) problems.push(`not generated: ${file}`);
  if (problems.length > 0) {
    console.error(
      `docs/api is out of date. Run \`pnpm openapi\` and commit the result.\n- ${problems.join('\n- ')}`,
    );
    process.exit(1);
  }
  console.log(`OpenAPI files are up to date (${expected.size - 1} operations).`);
} else {
  await mkdir(OPERATIONS_DIR, { recursive: true });
  for (const file of present) if (!expected.has(file)) await rm(join(API_DIR, file));
  for (const [file, text] of expected) {
    const current = await readFile(join(API_DIR, file), 'utf8').catch(() => null);
    if (current !== text) await writeFile(join(API_DIR, file), text);
  }
  console.log(`Wrote ${expected.size - 1} operation files and document.json to docs/api.`);
}
