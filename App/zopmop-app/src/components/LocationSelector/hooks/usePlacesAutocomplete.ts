import { useState, useRef, useCallback, useEffect } from 'react';
import { searchPlaces, type PlaceResult } from '../../../api/places';

const DEBOUNCE_MS = 180;

type SearchState = 'idle' | 'loading' | 'results' | 'no_results' | 'error';

export function usePlacesAutocomplete(token: string | null) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [state, setState] = useState<SearchState>('idle');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef(false);

  const search = useCallback(
    async (q: string) => {
      if (!token || !q.trim()) return;
      abortRef.current = false;
      setState('loading');
      try {
        // TODO(places): add session_token param once backend supports it
        const items = await searchPlaces(token, q.trim());
        if (abortRef.current) return;
        if (items.length === 0) {
          setState('no_results');
          setResults([]);
        } else {
          setState('results');
          setResults(items);
        }
      } catch {
        if (!abortRef.current) setState('error');
      }
    },
    [token],
  );

  const handleQueryChange = useCallback(
    (text: string) => {
      setQuery(text);
      abortRef.current = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!text.trim()) {
        setState('idle');
        setResults([]);
        return;
      }
      setState('loading');
      debounceRef.current = setTimeout(() => search(text), DEBOUNCE_MS);
    },
    [search],
  );

  const clear = useCallback(() => {
    abortRef.current = true;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setQuery('');
    setResults([]);
    setState('idle');
  }, []);

  const retry = useCallback(() => {
    if (query.trim()) search(query);
  }, [query, search]);

  useEffect(() => {
    return () => {
      abortRef.current = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return { query, results, state, handleQueryChange, clear, retry };
}
