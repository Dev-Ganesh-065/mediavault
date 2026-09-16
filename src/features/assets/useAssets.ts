import { useEffect, useState } from 'react';
import { listAssets } from '@/api/client';
import type { Asset, AssetQuery } from '@/lib/types';

interface State {
  items: Asset[];
  total: number;
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
}

/**
 * Baseline loader. Reviewers know this hook is wrong in several ways.
 * Replacing it wholesale is expected and encouraged.
 */
export function useAssets(query: AssetQuery) {
  const [state, setState] = useState<State>({
    items: [],
    total: 0,
    nextCursor: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    listAssets(query)
      .then((page) => {
        setState({
          items: page.items,
          total: page.total,
          nextCursor: page.nextCursor,
          loading: false,
          error: null,
        });
      })
      .catch((err: unknown) => {
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : 'Something went wrong',
        }));
      });
  }, [JSON.stringify(query)]);

  return state;
}
