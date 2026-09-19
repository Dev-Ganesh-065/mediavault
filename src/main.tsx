import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { queryClient } from '@/api/queryClient';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

/*
 * `<StrictMode>` is deliberately NOT used here. Its development-only
 * double-invocation of effects mounts, unmounts and remounts the app within
 * the same tick, and the first unmount aborts the signal that TanStack Query
 * handed to the in-flight fetch. Every initial API request then visibly fails
 * (`net::ERR_ABORTED`) on the first call and only succeeds when the remount
 * immediately re-issues it — an intermittent-looking network failure that
 * exists solely in dev. Without StrictMode the initial fetch runs exactly
 * once; cancellation for real key changes still works via the query signal.
 */
createRoot(container).render(
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </ErrorBoundary>,
);
