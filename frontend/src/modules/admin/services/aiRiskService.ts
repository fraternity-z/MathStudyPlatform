import { apiClient } from '@/libs/http/apiClient';
import type {
  AIRiskEventListQuery,
  AIRiskEventListResponse,
  AIRiskOverview,
  AIRiskSettings,
  AIStudentAccessResponse,
  AIStudentListQuery,
  AIStudentListResponse,
  UpdateAIRiskSettingsRequest,
  UpdateAIStudentAccessRequest,
} from '@/modules/admin/types/aiRisk';

const BASE_PATH = '/admin/risk-control';

function compactParams(query: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined && value !== '' && value !== 'all')
  );
}

export const aiRiskService = {
  async getOverview(signal?: AbortSignal): Promise<AIRiskOverview> {
    const response = await apiClient.get<AIRiskOverview>(`${BASE_PATH}/overview`, { signal });
    return response.data;
  },

  async getSettings(signal?: AbortSignal): Promise<AIRiskSettings> {
    const response = await apiClient.get<AIRiskSettings>(`${BASE_PATH}/settings`, { signal });
    return response.data;
  },

  async updateSettings(request: UpdateAIRiskSettingsRequest): Promise<AIRiskSettings> {
    const response = await apiClient.put<AIRiskSettings>(`${BASE_PATH}/settings`, request);
    return response.data;
  },

  async listStudents(query: AIStudentListQuery = {}, signal?: AbortSignal): Promise<AIStudentListResponse> {
    const response = await apiClient.get<AIStudentListResponse>(`${BASE_PATH}/students`, {
      params: compactParams(query as Record<string, unknown>),
      signal,
    });
    return response.data;
  },

  async updateStudentAccess(
    studentId: string,
    request: UpdateAIStudentAccessRequest
  ): Promise<AIStudentAccessResponse> {
    const response = await apiClient.patch<AIStudentAccessResponse>(
      `${BASE_PATH}/students/${studentId}/access`,
      request
    );
    return response.data;
  },

  async listEvents(query: AIRiskEventListQuery = {}, signal?: AbortSignal): Promise<AIRiskEventListResponse> {
    const response = await apiClient.get<AIRiskEventListResponse>(`${BASE_PATH}/events`, {
      params: compactParams(query as Record<string, unknown>),
      signal,
    });
    return response.data;
  },
};

export default aiRiskService;
