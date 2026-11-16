import type { FlowDef } from './flows.ts';
import { LookupFlow } from './lookup.tsx';
import { PickFlow } from './pick.tsx';
import { ReceiveFlow } from './receive.tsx';

/**
 * Every flow on the scan page, in tab order. A flow that is not built yet shows "coming soon";
 * replacing `soon` with a component is all it takes to plug one in (I4b: count, move, quick
 * add). A flow can hand over to another with `env.startFlow(id, preset)`: a short pick asks
 * Count for its position this way.
 */
export const FLOWS: FlowDef[] = [
  { id: 'lookup', label: 'Look up', permission: 'inventory.read', Component: LookupFlow },
  { id: 'receive', label: 'Receive', permission: 'inventory.receive', Component: ReceiveFlow },
  { id: 'pick', label: 'Pick', permission: 'inventory.read', Component: PickFlow },
  {
    id: 'count',
    label: 'Count',
    permission: 'inventory.read',
    soon: 'Counting by scan is coming soon.',
    Component: LookupFlow,
  },
  {
    id: 'move',
    label: 'Move',
    permission: 'inventory.read',
    soon: 'Moving stock by scan is coming soon.',
    Component: LookupFlow,
  },
  {
    id: 'quick-add',
    label: 'Quick add',
    permission: 'catalog.write',
    soon: 'Quick add (a one-of-a-kind item from the phone) is coming soon.',
    Component: LookupFlow,
  },
];
