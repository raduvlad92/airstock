import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedShop } from '../../../test/helpers.ts';
import { mcpSession } from './mcp-client.ts';
import { type TestApp, testApp } from './setup.ts';

// The tool list is a contract with MCP clients (PRD 9.3). Phase 2 gates on measured tool choice,
// not a count (ADR 0005, update of 16 November 2026). A new tool adds one line here; a new action
// on an existing tool does not.

let t: TestApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(() => t.close());

describe('MCP tools', () => {
  it('gives clients server instructions that route by task and name only real tools', async () => {
    const shop = await seedShop(t.db, t.sink, 'MCP instructions shop');
    const mcp = await mcpSession(t, shop, ['shop:read']);
    const instructions = mcp.client.getInstructions() ?? '';
    const { tools } = await mcp.client.listTools();
    const names = new Set(tools.map((x) => x.name));
    // OpenAI asks for the first 512 characters to stand alone: the routing paragraph fits.
    const opening = instructions.split('\n\n')[0] ?? '';
    expect(opening.length).toBeLessThanOrEqual(512);
    expect(opening).toContain('get_stock');
    expect(opening).toContain('search_catalog');
    for (const word of instructions.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []) {
      if (
        word.includes('_') &&
        /^(get|search|edit|manage|receive|transfer|adjust|import|run|stock|shopify|describe|warehouse)_/.test(
          word,
        )
      ) {
        expect(names, word).toContain(word);
      }
    }
  });

  it('lists exactly these task-shaped tools, whatever the grant allows', async () => {
    const shop = await seedShop(t.db, t.sink, 'MCP tools shop');
    const mcp = await mcpSession(t, shop, ['shop:read']);
    const { tools } = await mcp.client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual([
      'adjust_stock',
      'describe_catalog',
      'edit_catalog',
      'get_operation_outcome',
      'get_shop_context',
      'get_stock',
      'import_export',
      'manage_catalog_schema',
      'manage_media',
      'manage_purchasing',
      'manage_reservations',
      'manage_returns',
      'manage_storage',
      'manage_suppliers',
      'receive_stock',
      'search_activity',
      'search_catalog',
      'stock_alerts',
      'transfer_stock',
      'warehouse_work',
    ]);
    await mcp.close();
  });
});
