import { CountFlow } from './count.tsx';
import type { FlowDef } from './flows.ts';
import { LookupFlow } from './lookup.tsx';
import { MoveFlow } from './move.tsx';
import { PickFlow } from './pick.tsx';
import { QuickAddFlow } from './quick-add.tsx';
import { ReceiveFlow } from './receive.tsx';

/**
 * Every flow on the scan page, in tab order. A flow can hand over to another with
 * `env.startFlow(id, preset)`: a short pick asks Count for its shelf this way, and an unknown code
 * offers Quick add with the code as the certificate number.
 */
export const FLOWS: FlowDef[] = [
  { id: 'lookup', label: 'Look up', permission: 'inventory.read', Component: LookupFlow },
  { id: 'receive', label: 'Receive', permission: 'inventory.receive', Component: ReceiveFlow },
  { id: 'pick', label: 'Pick', permission: 'inventory.read', Component: PickFlow },
  { id: 'count', label: 'Count', permission: 'inventory.count', Component: CountFlow },
  { id: 'move', label: 'Move', permission: 'inventory.transfer', Component: MoveFlow },
  { id: 'quick-add', label: 'Quick add', permission: 'catalog.write', Component: QuickAddFlow },
];
