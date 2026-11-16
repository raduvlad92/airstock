// biome-ignore-all lint/suspicious/noExplicitAny: tool answers are read loosely, as a model would
/**
 * The calls ChatGPT is expected to make for each prompt of the Phase 2 ChatGPT run
 * (docs/chatgpt-runs/phase-2.json), made by a plain MCP client: the lookups a model needs first,
 * then the expected tool and action. Used by chatgpt-run.test.ts in-process, and by a dry run
 * against a local Worker over HTTP. Each prompt returns what a correct answer would say, so the
 * expected answers in docs/phase-2-status.md Section 6 come from a run.
 */

export interface McpCaller {
  call(tool: string, args?: Record<string, unknown>): Promise<{ error: boolean; body: any }>;
}

/** An MCP SDK client as a caller; a tool error that is not JSON (input validation) stays text. */
export function mcpCaller(client: {
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
}): McpCaller {
  return {
    async call(tool, args = {}) {
      const res = (await client.callTool({ name: tool, arguments: args })) as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
      };
      const text = res.content?.[0]?.text ?? 'null';
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { error: res.isError === true, body };
    },
  };
}

export interface PromptRun {
  prompt: number;
  /** When its first call was sent. */
  startedAt: Date;
  answer: string;
}

/** A tool call that must succeed; its JSON answer. */
async function ok(mcp: McpCaller, tool: string, args: Record<string, unknown>): Promise<any> {
  const res = await mcp.call(tool, args);
  if (res.error) {
    throw new Error(`${tool} ${String(args.action ?? '')}: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

/** The variant with this SKU, found the way a model would: a catalog search. */
async function variantBySku(mcp: McpCaller, sku: string): Promise<string> {
  const found = await ok(mcp, 'search_catalog', { action: 'query', search: sku });
  const row = (found.rows ?? found.items ?? []).find((r: any) => r.sku === sku);
  if (!row) throw new Error(`No variant ${sku}: ${JSON.stringify(found).slice(0, 500)}`);
  return row.variantId ?? row.id;
}

async function locationByCode(mcp: McpCaller, code: string): Promise<string> {
  const { locations } = await ok(mcp, 'manage_storage', { action: 'list_locations' });
  const location = locations.find((l: any) => l.code === code);
  if (!location) throw new Error(`No location ${code}`);
  return location.locationId;
}

const qty = (value: unknown) => Number(value ?? 0);

export interface PromptOptions {
  /** Prompt 8's earlier moment, as the seed script printed it. */
  valueMoment: string;
  /** Called between prompts (a pause, so the harness can split them by time). */
  between?: () => Promise<void>;
}

/** Prompts 1 to 12 on a full-access connection (13 and 14 need Shopify and are skipped). */
export async function runFullAccessPrompts(
  mcp: McpCaller,
  { valueMoment, between = async () => {} }: PromptOptions,
): Promise<PromptRun[]> {
  const runs: PromptRun[] = [];
  const prompt = async (n: number, fn: () => Promise<string>) => {
    if (runs.length > 0) await between();
    const startedAt = new Date();
    runs.push({ prompt: n, startedAt, answer: await fn() });
  };

  await prompt(1, async () => {
    const variantId = await variantBySku(mcp, 'PKM-SSP-BB');
    const stock = await ok(mcp, 'get_stock', { action: 'stock', variantId });
    return JSON.stringify(stock);
  });

  await prompt(2, async () => {
    const variantId = await variantBySku(mcp, 'PKM-SSP-BB');
    const a1 = await locationByCode(mcp, 'A1');
    const { suppliers } = await ok(mcp, 'manage_suppliers', { action: 'list' });
    const supplier = suppliers.find((s: any) => s.name === 'Nordwind TCG Distribution');
    const packaging = await ok(mcp, 'search_catalog', { action: 'get_packaging', variantId });
    const pack = packaging.packs.find((p: any) => p.name === 'Case');
    const receipt = await ok(mcp, 'receive_stock', {
      action: 'receive',
      variantId,
      locationId: a1,
      quantity: '3',
      packId: pack.id,
      unitCost: '95',
      costPer: 'base_unit',
      supplierId: supplier.id,
    });
    return JSON.stringify(receipt);
  });

  await prompt(3, async () => {
    const variantId = await variantBySku(mcp, 'PKM-PRE-ETB');
    const moved = await ok(mcp, 'transfer_stock', {
      action: 'move',
      fromLocationId: await locationByCode(mcp, 'A1'),
      toLocationId: await locationByCode(mcp, 'B2'),
      lines: [{ variantId, quantity: '2' }],
    });
    return JSON.stringify(moved);
  });

  await prompt(4, async () => {
    const alerts = await ok(mcp, 'stock_alerts', { action: 'list', kind: 'low_stock' });
    const suggested = await ok(mcp, 'manage_purchasing', { action: 'suggest_from_low_stock' });
    const drafts: unknown[] = [];
    for (const order of suggested.drafts) {
      drafts.push(
        await ok(mcp, 'manage_purchasing', {
          action: 'draft',
          supplierId: order.supplierId,
          warehouseId: order.warehouseId,
          lines: order.lines.map((l: any) => ({
            variantId: l.variantId,
            quantity: l.quantity,
            ...(l.packId ? { packId: l.packId } : {}),
            ...(l.unitCost ? { unitCost: l.unitCost } : {}),
          })),
        }),
      );
    }
    return JSON.stringify({ alerts, suggested, drafts });
  });

  await prompt(5, async () => {
    const expiring = await ok(mcp, 'run_report', {
      action: 'run',
      report: 'expiring_lots',
      days: 30,
    });
    const variantId = await variantBySku(mcp, 'FOOD-SHAKE-CHOC');
    const trace = await ok(mcp, 'get_stock', { action: 'lot_trace', variantId, lotCode: 'L-2311' });
    return JSON.stringify({ expiring, trace });
  });

  await prompt(6, async () => {
    const rivendell = await variantBySku(mcp, 'LEGO-10316');
    const daytona = await variantBySku(mcp, 'LEGO-42143');
    const counted = await ok(mcp, 'adjust_stock', {
      action: 'count',
      locationId: await locationByCode(mcp, 'B2'),
      counts: [
        { variantId: rivendell, counted: '4' },
        { variantId: daytona, counted: '0' },
      ],
    });
    return JSON.stringify(counted);
  });

  await prompt(7, async () => {
    const { reservations } = await ok(mcp, 'manage_reservations', {
      action: 'list',
      externalRef: '1001',
      status: 'all',
    });
    const created = await ok(mcp, 'manage_returns', {
      action: 'create',
      orderRef: '1001',
      lines: [{ variantId: reservations[0].variantId, quantity: '1' }],
      reason: 'Damaged',
    });
    return JSON.stringify({ reservations, created });
  });

  await prompt(8, async () => {
    const now = await ok(mcp, 'run_report', { action: 'run', report: 'inventory_value' });
    const earlier = await ok(mcp, 'run_report', {
      action: 'run',
      report: 'inventory_value',
      at: valueMoment,
    });
    return JSON.stringify({ now: now.totals, earlier: earlier.totals });
  });

  await prompt(9, async () => {
    const added = await ok(mcp, 'receive_stock', {
      action: 'quick_add',
      locationId: await locationByCode(mcp, 'A1'),
      name: 'Charizard 4/102 Base Set PSA 10',
      barcode: '12345678',
      price: '450',
      family: 'Trading cards',
      fields: {
        game: 'Pokémon',
        set_name: 'Base Set',
        card_number: '4/102',
        grading_company: 'PSA',
        grade: '10',
        certificate_number: '12345678',
      },
      status: 'active',
    });
    return JSON.stringify(added);
  });

  await prompt(10, async () => {
    const { warehouses } = await ok(mcp, 'manage_storage', { action: 'list_warehouses' });
    const main = warehouses.find((w: any) => w.name === 'Main warehouse');
    const created = await ok(mcp, 'warehouse_work', {
      action: 'create_pick_list',
      warehouseId: main.warehouseId,
    });
    return JSON.stringify(created);
  });

  await prompt(11, async () => {
    const { pickLists } = await ok(mcp, 'warehouse_work', { action: 'list_pick_lists' });
    const { pickListId } = pickLists.find((l: any) => l.number === 1);
    const list = await ok(mcp, 'warehouse_work', { action: 'get_pick_list', pickListId });
    const pikachu = await variantBySku(mcp, 'PKM-PIKA-EXBOX');
    const line = list.pickLines.find((l: any) => l.variantId === pikachu);
    const shorted = await ok(mcp, 'warehouse_work', {
      action: 'short_pick',
      pickListId,
      lineId: line.lineId,
      found: '1',
    });
    return JSON.stringify({ line, shorted });
  });

  await prompt(12, async () => {
    const scanned = await ok(mcp, 'warehouse_work', { action: 'scan', code: '84731629' });
    return JSON.stringify(scanned);
  });

  return runs;
}

/** Prompt 15 on a read-only connection: a write that must be refused. */
export async function runReadOnlyPrompt(mcp: McpCaller): Promise<PromptRun> {
  const startedAt = new Date();
  const variantId = await variantBySku(mcp, 'PKM-PRE-ETB');
  const refused = await mcp.call('adjust_stock', {
    action: 'count',
    locationId: await locationByCode(mcp, 'A1'),
    counts: [{ variantId, counted: '0' }],
  });
  if (!refused.error) throw new Error('The read-only connection changed stock.');
  return { prompt: 15, startedAt, answer: JSON.stringify(refused.body) };
}

export { qty };
