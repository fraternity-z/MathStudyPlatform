import { apiClient } from '@/libs/http/apiClient';
import { authTokenStorage } from '@/libs/auth/tokenStorage';

export interface LoginCredentials {
  username: string;
  password: string;
  role: 'student' | 'teacher';
  captchaToken: string;
}

export interface AdminLoginCredentials {
  username: string;
  password: string;
  captchaToken: string;
}

export interface LoginCaptchaChallenge {
  captcha_id: string;
  background_image: string;
  piece_image: string;
  width: number;
  height: number;
  piece_width: number;
  piece_height: number;
  piece_y: number;
  expires_in: number;
}

export interface LoginCaptchaVerification {
  captcha_token: string;
  expires_in: number;
}

/** 登录接口的原始响应（角色由服务端根据数据库返回，可能是任意角色） */
export interface LoginApiResponse {
  access_token: string;
  token_type: string;
  user: {
    id: string;
    username: string;
    email: string;
    role: 'student' | 'teacher' | 'admin';
  };
}

export interface AuthResponse {
  token: string;
  user: {
    id: string;
    name: string;
    role: 'student' | 'teacher' | 'admin';
  };
}

export interface AdminAuthResponse {
  access_token: string;
  token_type: string;
  user: {
    id: string;
    username: string;
    email: string;
    role: 'student' | 'teacher' | 'admin';
  };
}

export interface ChangePasswordRequest {
  old_password: string;
  new_password: string;
}

export interface RegisterCredentials {
  username: string;
  email: string;
  password: string;
  role: 'student' | 'teacher';
}

export interface UserInfo {
  id: string;
  username: string;
  email: string;
  role: 'student' | 'teacher' | 'admin';
}

export const authService = {
  async login(credentials: LoginCredentials): Promise<AuthResponse> {
    const response = await apiClient.post<LoginApiResponse>('/auth/login', {
      username: credentials.username,
      password: credentials.password,
      captcha_token: credentials.captchaToken,
    });

    // 字段映射：后端返回格式 -> 前端期望格式（角色必须使用服务端返回的真实角色，不能使用表单选择）
    return {
      token: response.data.access_token,
      user: {
        id: response.data.user.id,
        name: response.data.user.username,
        role: response.data.user.role,
      },
    };
  },

  async adminLogin(credentials: AdminLoginCredentials): Promise<AdminAuthResponse> {
    const response = await apiClient.post<AdminAuthResponse>('/auth/login', {
      username: credentials.username,
      password: credentials.password,
      captcha_token: credentials.captchaToken,
    });
    return response.data;
  },

  async getLoginCaptcha(): Promise<LoginCaptchaChallenge> {
    const response = await apiClient.get<LoginCaptchaChallenge>('/auth/captcha');
    return response.data;
  },

  async verifyLoginCaptcha(captchaId: string, position: number): Promise<LoginCaptchaVerification> {
    const response = await apiClient.post<LoginCaptchaVerification>('/auth/captcha/verify', {
      captcha_id: captchaId,
      position,
    });
    return response.data;
  },

  async register(data: RegisterCredentials): Promise<void> {
    await apiClient.post('/auth/register', data);
  },

  async changePassword(data: ChangePasswordRequest): Promise<{ message: string }> {
    const response = await apiClient.put<{ message: string }>('/auth/change-password', data);
    return response.data;
  },

  async logout() {
    try {
      // 调用后端登出接口清除 HttpOnly Cookie
      await apiClient.post('/auth/logout');
    } catch {
      // 即使后端调用失败，也清除本地 token
    }
    authTokenStorage.clear();
  },

  async getCurrentUser(signal?: AbortSignal): Promise<UserInfo> {
    const response = await apiClient.get<UserInfo>('/auth/me', { signal });
    return response.data;
  },
};

export default authService;
