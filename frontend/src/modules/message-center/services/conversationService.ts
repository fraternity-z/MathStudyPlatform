import { apiClient } from '@/libs/http/apiClient';
import { buildQueryString } from '@/modules/message-center/services/queryParams';
import type { MessageAttachment } from '@/modules/message-center/attachmentTypes';

export interface Message {
  id: string;
  from: string;
  text: string;
  time: string;
  read_by_recipient?: boolean;
  attachments: MessageAttachment[];
}

export interface ConversationItem {
  id: string;
  student_id?: string;
  teacher_id?: string;
  student_name?: string;
  teacher_name?: string;
  class_name?: string;
  scope?: string;
  last_message: string;
  last_time: string;
  unread: number;
  pending_reply?: boolean;
  archived: boolean;
}

export interface ConversationDetail extends ConversationItem {
  messages: Message[];
  messages_total: number;
  messages_page: number;
  messages_page_size: number;
  read_through_message_id?: string;
}

export interface ListResponse {
  items: ConversationItem[];
  total: number;
  page: number;
  page_size: number;
}

export interface Contact {
  id: string;
  display_name: string;
  scope: string;
}

const BASE = '/conversations';

export const conversationService = {
  async list(params: {
    search?: string;
    status?: string;
    class_name?: string;
    page?: number;
    page_size?: number;
  }, signal?: AbortSignal): Promise<ListResponse> {
    const qs = buildQueryString(params);
    const { data } = await apiClient.get<ListResponse>(`${BASE}?${qs}`, { signal });
    return data;
  },

  async get(
    id: string,
    params?: { messages_page?: number; messages_page_size?: number },
    signal?: AbortSignal,
  ): Promise<ConversationDetail> {
    const { data } = await apiClient.get<ConversationDetail>(`${BASE}/${id}`, { params, signal });
    return data;
  },

  async acknowledgeRead(id: string, throughMessageId: string, signal?: AbortSignal): Promise<void> {
    await apiClient.put(`${BASE}/${id}/read`, { through_message_id: throughMessageId }, { signal });
  },

  async create(body: {
    target_id: string;
    subject?: string;
    initial_message?: string;
    attachments?: MessageAttachment[];
  }): Promise<ConversationDetail> {
    const { data } = await apiClient.post<ConversationDetail>(BASE, body);
    return data;
  },

  async sendMessage(id: string, text: string, attachments: MessageAttachment[] = []): Promise<Message> {
    const { data } = await apiClient.post<Message>(`${BASE}/${id}/messages`, { text, attachments });
    return data;
  },

  async studentContacts(): Promise<{ contacts: Contact[] }> {
    const { data } = await apiClient.get<{ contacts: Contact[] }>(`${BASE}/contacts/students`);
    return data;
  },

  async searchUsers(q: string): Promise<{ contacts: Contact[] }> {
    const { data } = await apiClient.get<{ contacts: Contact[] }>(`${BASE}/search-users`, { params: { q } });
    return data;
  },

  async archive(id: string): Promise<void> {
    await apiClient.put(`${BASE}/${id}/archive`);
  },

  async contacts(): Promise<{ contacts: Contact[] }> {
    const { data } = await apiClient.get<{ contacts: Contact[] }>(`${BASE}/contacts/teachers`);
    return data;
  },
};
