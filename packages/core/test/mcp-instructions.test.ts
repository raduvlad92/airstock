import { describe, expect, it } from 'vitest';
import { mcpInstructions } from '../src/mcp-instructions.ts';

// The 22 tools planned for Phase 2 (plan Section 5.16). OpenAI asks for the server instructions'
// first 512 characters to stand alone, so the routing paragraph must fit with all of them.
const PLANNED = [
  'get_shop_context',
  'describe_catalog',
  'manage_catalog_schema',
  'search_catalog',
  'edit_catalog',
  'manage_media',
  'manage_suppliers',
  'manage_storage',
  'import_export',
  'get_operation_outcome',
  'search_activity',
  'receive_stock',
  'manage_reservations',
  'get_stock',
  'transfer_stock',
  'adjust_stock',
  'manage_returns',
  'manage_purchasing',
  'stock_alerts',
  'warehouse_work',
  'run_report',
  'shopify_sync',
];

describe('MCP server instructions', () => {
  it('routes by task within 512 characters with every planned tool', () => {
    const opening = mcpInstructions(PLANNED).split('\n\n')[0]!;
    expect(opening.length).toBeLessThanOrEqual(512);
    for (const tool of [
      'search_catalog',
      'get_stock',
      'receive_stock',
      'run_report',
      'shopify_sync',
    ])
      expect(opening).toContain(tool);
  });

  it('never names a tool that is not registered', () => {
    const text = mcpInstructions(['get_stock', 'search_catalog']);
    expect(text).not.toContain('run_report');
    expect(text).not.toContain('shopify_sync');
    expect(text).not.toContain('adjust_stock');
    expect(text).toContain('get_stock');
  });
});
