import { useEffect, useState } from 'react';

/**
 * Tracks navigator online/offline. When we go offline the list hook stops
 * hammering the network; the banner tells the user what is happening, and
 * everything resumes by itself on reconnect.
 */
export function useOffline(): boolean {
  const [online, setOnline] = useState<boolean>(() => window.navigator.onLine !== false);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}