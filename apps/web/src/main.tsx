import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from './api.ts';
import { registerMediaExtensions } from './components/media/catalog.tsx';
import { AppInfoProvider } from './context.tsx';
import { createAppRouter } from './router.tsx';
import { telemetry } from './telemetry.ts';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('The shell page has no #root element.');

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      // Permission and not-found answers do not change on retry.
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});

registerMediaExtensions();
const router = createAppRouter();
telemetry.start();

createRoot(root).render(
  <StrictMode>
    <AppInfoProvider info={{ email: root.dataset.email ?? '', mcpUrl: root.dataset.mcpUrl ?? '' }}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AppInfoProvider>
  </StrictMode>,
);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
