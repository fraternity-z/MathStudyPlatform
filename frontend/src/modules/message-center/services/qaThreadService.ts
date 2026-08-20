import { apiClient } from '@/libs/http/apiClient';
import { buildQueryString } from '@/modules/message-center/services/queryParams';
import type { MessageAttachment } from '@/modules/message-center/attachmentTypes';

export interface ThreadMessage {
  id: string;
  from: string;
  text: string;
  time: string;
  attachments: MessageAttachment[];
}

export interface StudentThreadItem {
  id: string;
  title: string;
  teacher_id: string;
  teacher_name: string;
  source: string;
  context_preview: string;
  status: string;
  class_id?: string;
  class_name?: string;
  unread: boolean;
  last_update: string;
}

export interface TeacherThreadItem {
  id: string;
  student_name: string;
  class_id?: string;
  class_name: string;
  title: string;
  source: string;
  knowledge_point: string;
  resource_name?: string;
  status: string;
  context_preview: string;
  last_update: string;
}

export interface ThreadDetail {
  id: string;
  student_name?: string;
  teacher_name?: string;
  class_id?: string;
  class_name?: string;
  title: string;
  teacher_id?: string;
  source: string;
  knowledge_point?: string;
  resource_name?: string;
  status: string;
  context: string;
  messages: ThreadMessage[];
  messages_total: number;
  messages_page: number;
  messages_page_size: number;
  read_through_message_id?: string;
}

export interface ListResponse<T extends StudentThreadItem | TeacherThreadItem = StudentThreadItem | TeacherThreadItem> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

const BASE = '/qa-threads';

export const qaThreadService = {
  async list<T extends StudentThreadItem | TeacherThreadItem = StudentThreadItem | TeacherThreadItem>(params: {
    search?: string;
    status?: string;
    class_name?: string;
    teacher_id?: string;
    page?: number;
    page_size?: number;
  }, signal?: AbortSignal): Promise<ListResponse<T>> {
    const qs = buildQueryString(params);
    const { data } = await apiClient.get<ListResponse<T>>(`${BASE}?${qs}`, { signal });
    return data;
  },

  async get(
    id: string,
    params?: { messages_page?: number; messages_page_size?: number },
    signal?: AbortSignal,
  ): Promise<ThreadDetail> {
    const { data } = await apiClient.get<ThreadDetail>(`${BASE}/${id}`, { params, signal });
    return data;
  },

  async acknowledgeRead(id: string, throughMessageId: string, signal?: AbortSignal): Promise<void> {
    await apiClient.put(`${BASE}/${id}/read`, { through_message_id: throughMessageId }, { signal });
  },

  async create(body: {
    teacher_id?: string;
    content: string;
    source?: string;
    attachments?: MessageAttachment[];
  }): Promise<ThreadDetail> {
    const { data } = await apiClient.post<ThreadDetail>(BASE, body);
    return data;
  },

  async importQuestion(body: {
    teacher_id: string;
    source: string;
    content: string;
  }): Promise<ThreadDetail> {
    const { data } = await apiClient.post<ThreadDetail>(`${BASE}/import`, body);
    return data;
  },

  async sendMessage(id: string, text: string, attachments: MessageAttachment[] = []): Promise<ThreadMessage> {
    const { data } = await apiClient.post<ThreadMessage>(`${BASE}/${id}/messages`, { text, attachments });
    return data;
  },

  async updateStatus(id: string, status: string): Promise<void> {
    await apiClient.put(`${BASE}/${id}/status`, { status });
  },
};
