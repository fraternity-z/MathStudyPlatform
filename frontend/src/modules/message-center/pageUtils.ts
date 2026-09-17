export async function fetchMessageCenterPage<T>(
  page: number,
  pageSize: number,
  fetchPage: (page: number) => Promise<{ items: T[]; total: number }>,
): Promise<{ items: T[]; total: number; page: number }> {
  const response = await fetchPage(page);
  const lastPage = Math.max(1, Math.ceil(response.total / pageSize));
  if (page > lastPage) return { ...await fetchPage(lastPage), page: lastPage };
  return { ...response, page };
}

export function hasMinimumGlobalSearchCharacters(search: string): boolean {
  return (search.match(/[\p{L}\p{N}]/gu) ?? []).length >= 2;
}

export async function fetchStableOffsetMessageWindow<T extends { id: string; time: string }>(
  lastPage: number,
  pageSize: number,
  fetchPage: (page: number) => Promise<{ messages: T[]; messages_total: number }>,
): Promise<{ messages: T[]; total: number }> {
  let previousFingerprint = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const pages: Array<{ messages: T[]; messages_total: number }> = [];
    for (let page = 1; page <= lastPage; page++) {
      pages.push(await fetchPage(page));
    }
    const total = Math.max(0, ...pages.map((page) => page.messages_total));
    const messages = pages.reduce<T[]>(
      (current, page) => mergeMessagesByID(current, page.messages),
      [],
    );
    const fingerprint = `${total}\u0000${messages.map((message) => message.id).join('\u0000')}`;
    if (messages.length === Math.min(total, lastPage * pageSize) && fingerprint === previousFingerprint) {
      return { messages, total };
    }
    previousFingerprint = fingerprint;
  }

  throw new Error('message history changed while loading');
}

export function appendDeliveredMessage<
  M extends { id: string; time: string },
  T extends { messages: M[]; messages_total: number },
>(detail: T, message: M): T {
  return {
    ...detail,
    messages: mergeMessagesByID(detail.messages, [message]),
    messages_total: detail.messages_total + (detail.messages.some((current) => current.id === message.id) ? 0 : 1),
  };
}

export function mergeMessagesByID<T extends { id: string; time: string }>(
  current: T[],
  incoming: T[],
): T[] {
  const byID = new Map(current.map((message) => [message.id, message]));
  incoming.forEach((message) => byID.set(message.id, message));

  return [...byID.values()].sort((left, right) => {
    const leftTime = Date.parse(left.time);
    const rightTime = Date.parse(right.time);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    const timeOrder = left.time.localeCompare(right.time);
    return timeOrder !== 0 ? timeOrder : left.id.localeCompare(right.id);
  });
}
