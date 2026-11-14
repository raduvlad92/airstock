/**
 * Writes docs/api/openapi.json from the operation registry. `--check` fails when the
 * committed file is out of date, so the published contract cannot drift from the code.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { type AnyOperation, operations } from '@airstock/core';
import { z } from 'zod';

const OUT = fileURLToPath(new URL('../docs/api/openapi.json', import.meta.url));

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
        'Unique per command. Retrying with the same key returns the original result without repeating the effect.',
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

const paths: Record<string, Record<string, unknown>> = {};
for (const op of operations) {
  const path = `/api/v1${op.http.path}`;
  paths[path] ??= {};
  paths[path][op.http.method.toLowerCase()] = operationObject(op);
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
  paths,
};

const text = `${JSON.stringify(document, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const current = await readFile(OUT, 'utf8').catch(() => '');
  if (current !== text) {
    console.error(
      'docs/api/openapi.json is out of date. Run `pnpm openapi` and commit the result.',
    );
    process.exit(1);
  }
  console.log('OpenAPI document is up to date.');
} else {
  await writeFile(OUT, text);
  console.log(`Wrote ${OUT}`);
}
