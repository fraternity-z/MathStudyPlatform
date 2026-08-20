import { apiClient } from '@/libs/http/apiClient';
import type {
  PasswordResetSubmitRequest,
  PasswordResetSubmitResponse,
  PasswordResetStatusResponse,
  PasswordResetListResponse,
  PasswordResetReviewRequest,
  PasswordResetReviewResponse,
} from '@/modules/password-reset/types/passwordReset';

export const passwordResetService = {
  // 用户端（公开接口）
  async submit(data: PasswordResetSubmitRequest): Promise<PasswordResetSubmitResponse> {
    const res = await apiClient.post<PasswordResetSubmitResponse>('/auth/forgot-password', data);
    return res.data;
  },

  async getStatus(username: string, email: string): Promise<PasswordResetStatusResponse> {
    const res = await apiClient.get<PasswordResetStatusResponse>('/auth/forgot-password/status', {
      params: { username, email },
    });
    return res.data;
  },

  // 管理员端
  async listRequests(params?: {
    status?: string;
    page?: number;
    page_size?: number;
  }, signal?: AbortSignal): Promise<PasswordResetListResponse> {
    const res = await apiClient.get<PasswordResetListResponse>('/admin/inbox', { params, signal });
    return res.data;
  },

  async getPendingCount(signal?: AbortSignal): Promise<{ pending_count: number }> {
    const res = await apiClient.get<{ pending_count: number }>('/admin/inbox/pending-count', { signal });
    return res.data;
  },

  async review(requestId: string, data: PasswordResetReviewRequest): Promise<PasswordResetReviewResponse> {
    const res = await apiClient.post<PasswordResetReviewResponse>(
      `/admin/inbox/${requestId}/review`,
      data,
    );
    return res.data;
  },
};

export default passwordResetService;
