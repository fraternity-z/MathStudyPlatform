import { useEffect, useState, type RefObject } from 'react';

// Markers sit after each incoming message, so a visible header cannot acknowledge
// messages below the viewport. Search results never advance the read position.
export function useVisibleMessageCutoff(
  containerRef: RefObject<HTMLDivElement | null>,
  scope: string,
  messages: ReadonlyArray<{ id: string }>,
  enabled: boolean,
): string {
  const [cutoff, setCutoff] = useState({ scope: '', id: '' });

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container || typeof IntersectionObserver === 'undefined') return;
    const positions = new Map(messages.map((message, index) => [message.id, index]));
    let active = true;
    const observer = new IntersectionObserver((entries) => {
      if (!active || document.hidden) return;
      const visibleIDs = entries
        .filter((entry) => entry.isIntersecting && entry.intersectionRatio >= 1)
        .map((entry) => (entry.target as HTMLElement).dataset.readMessageId ?? '')
        .filter((id) => positions.has(id));
      if (visibleIDs.length === 0) return;
      const latestID = visibleIDs.reduce((latest, id) => positions.get(id)! > positions.get(latest)! ? id : latest);
      setCutoff((current) => current.scope === scope && (positions.get(current.id) ?? -1) >= positions.get(latestID)!
        ? current
        : { scope, id: latestID });
    }, { threshold: 1 });
    container.querySelectorAll('[data-read-message-id]').forEach((marker) => observer.observe(marker));
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [containerRef, enabled, messages, scope]);

  return enabled && cutoff.scope === scope ? cutoff.id : '';
}
