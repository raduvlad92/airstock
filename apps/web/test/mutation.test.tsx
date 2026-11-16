// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { useMutation } from '../src/mutation.ts';

// React commits a new value to the page in one task and runs passive effects in a later one.
// TanStack Query's own useMutation picks up new options in a passive effect, so a tap in between
// ran the previous render's mutationFn (the scan page's "Receive 12" sent quantity 1).

afterEach(cleanup);

function Receive({ sent }: { sent: string[] }) {
  const [quantity, setQuantity] = useState('1');
  // A change that is not a user event, like a scan the server just answered.
  useEffect(() => {
    const t = setTimeout(() => setQuantity('2'), 0);
    return () => clearTimeout(t);
  }, []);
  const receive = useMutation({
    mutationFn: async () => {
      sent.push(quantity);
    },
  });
  return (
    <button type="button" onClick={() => receive.mutate()}>
      Receive {quantity}
    </button>
  );
}

it('runs the callbacks of the render on screen, even right after a commit', async () => {
  const sent: string[] = [];
  // Taps as soon as the new label is in the page: after the commit, before passive effects.
  const observer = new MutationObserver(() => {
    const button = screen.queryByRole('button', { name: 'Receive 2' });
    if (!button) return;
    observer.disconnect();
    fireEvent.click(button);
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Receive sent={sent} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(sent).toEqual(['2']));
});
