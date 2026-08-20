import { apiClient } from '@/libs/http/apiClient';

export interface XidianBindingStatus {
  is_bound: boolean;
  username?: string | null;
  last_verified_at?: string | null;
}

export interface XidianCaptchaChallenge {
  challenge_id: string;
  captcha_big: string;
  captcha_piece: string;
  puzzle_width: number;
  puzzle_height: number;
  piece_width: number;
  piece_height: number;
  piece_y: number;
}

export interface XidianBindCompleteRequest {
  challenge_id: string;
  slider_position: number;
  username?: string;
  password?: string;
}

export interface XidianBindCompleteResponse {
  is_bound: boolean;
  username: string;
  last_verified_at?: string | null;
}

export const xidianService = {
  async getBindingStatus(signal?: AbortSignal): Promise<XidianBindingStatus> {
    const response = await apiClient.get<XidianBindingStatus>('/xidian/binding', { signal });
    return response.data;
  },

  async startBinding(): Promise<XidianCaptchaChallenge> {
    const response = await apiClient.post<XidianCaptchaChallenge>('/xidian/binding/start');
    return response.data;
  },

  async completeBinding(request: XidianBindCompleteRequest): Promise<XidianBindCompleteResponse> {
    const response = await apiClient.post<XidianBindCompleteResponse>('/xidian/binding/complete', request);
    return response.data;
  },

  async unbind(): Promise<void> {
    await apiClient.post('/xidian/binding/unbind');
  },
};

export default xidianService;
