import { apiClient } from '@/libs/http/apiClient';

export const STUDY_STEPS = ['基础回顾', '概念理解', '例题推导', '理解检查', '回顾总结'] as const;
export type StudyFoundation = 'beginner' | 'familiar' | 'review';
export interface StudyProgress {
  topic: string;
  foundation: StudyFoundation;
  step: number;
  revision: number;
}

export const studyService = {
  async get(sessionId: string, signal?: AbortSignal): Promise<StudyProgress | null> {
    return (await apiClient.get<StudyProgress | null>(`/session/${sessionId}/study`, { signal })).data;
  },
  async start(sessionId: string, topic: string, foundation: StudyFoundation): Promise<StudyProgress> {
    return (await apiClient.patch<StudyProgress>(`/session/${sessionId}/study`, {
      action: 'start', revision: 0, topic, foundation,
    })).data;
  },
  async next(sessionId: string, revision: number): Promise<StudyProgress> {
    return (await apiClient.patch<StudyProgress>(`/session/${sessionId}/study`, { action: 'next', revision })).data;
  },
};
