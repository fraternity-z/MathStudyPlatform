import { useEffect, useState } from 'react';

export function usePageVisibility(): boolean {
  const [isVisible, setIsVisible] = useState(() => document.visibilityState !== 'hidden');

  useEffect(() => {
    const handleVisibilityChange = () => setIsVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  return isVisible;
}
