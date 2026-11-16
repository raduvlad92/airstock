/**
 * Server-wide guidance for MCP clients (Phase 2 plan D16, status Section 5.1). ChatGPT reads it
 * with the tool list. OpenAI asks for its first 512 characters to stand alone, so the opening
 * paragraph routes a request to the right tool by task; details follow.
 *
 * Built from the registered tool names, so a tool that does not exist is never mentioned, and a
 * new tool only needs a line here once it is registered.
 */

/** Opening routes: [task, tools in order of preference]. Only registered tools are named. */
const ROUTES: Array<[string, string[]]> = [
  ['catalog (products, variants, prices, barcodes)', ['search_catalog', 'edit_catalog']],
  ['stock levels, lots, serials, value', ['get_stock']],
  [
    'changing stock',
    ['receive_stock', 'manage_reservations', 'transfer_stock', 'adjust_stock', 'manage_returns'],
  ],
  ['purchasing', ['manage_purchasing', 'manage_suppliers']],
  ['alerts', ['stock_alerts']],
  ['picking', ['warehouse_work']],
  ['reports', ['run_report']],
  ['Shopify', ['shopify_sync']],
  ['history', ['search_activity']],
];

/** Detail lines, each tied to the tool it is about. */
const DETAILS: Array<[string, string]> = [
  [
    'get_shop_context',
    'Call get_shop_context first in a conversation: it names the shop this connection is bound to, its currency, units, and what the connection may do.',
  ],
  [
    'search_catalog',
    'Look up IDs with search_catalog before changing anything; never guess an ID. A scanned code goes to search_catalog (lookup_barcode).',
  ],
  [
    'edit_catalog',
    'Changes to many records go through edit_catalog bulk_preview, shown to the user, then bulk_commit.',
  ],
  [
    'receive_stock',
    'Quantities are exact decimal strings in the variant base unit. A pack (case, box) converts exactly; pass the pack instead of multiplying yourself.',
  ],
  [
    'manage_reservations',
    'Stock a customer order needs is reserved with manage_reservations; it never goes below zero available.',
  ],
  [
    'adjust_stock',
    'A counted quantity is a count in adjust_stock, not an adjustment you compute; every adjustment needs a reason.',
  ],
  [
    'import_export',
    'Exports start with import_export; the file is downloaded from the dashboard, never returned in chat.',
  ],
  [
    'get_operation_outcome',
    'Commands accept an idempotency_key. If a result is lost, ask get_operation_outcome with the same key instead of repeating the command.',
  ],
];

export function mcpInstructions(toolNames: readonly string[]): string {
  const known = new Set(toolNames);
  const routes = ROUTES.map(([task, tools]) => [task, tools.filter((t) => known.has(t))] as const)
    .filter(([, tools]) => tools.length > 0)
    .map(([task, tools]) => `${task}: ${tools.join(', ')}`);
  const opening = `Airstock is the merchant's catalog and inventory. Pick the tool by task. ${routes.join('; ')}.`;
  const details = DETAILS.filter(([tool]) => known.has(tool)).map(([, text]) => text);
  const closing =
    'Costs and values appear only if the connection is allowed to see them. Writes change the real shop: confirm with the user before committing.';
  return [opening, ...details, closing].join('\n\n');
}
