import type { LearningSession } from '@/types';

/** AI 会话支持的模式。 */
export type SessionMode = 'study' | 'chat' | 'practice' | 'explain';

/** 聊天页面沿用的模式名称。 */
export type ChatMode = SessionMode;

/** 首次发送期间固定不变的客户端草稿身份。 */
export interface DraftSessionIdentity {
  sessionId: string;
  topic?: string;
  mode: SessionMode;
}

/** 服务端开始处理后固定不变的首轮请求，用于严格幂等重放。 */
export interface DraftFirstRequest {
  inputText: string;
  message: string;
  attachments: string[];
}

/** 聊天侧栏使用的会话摘要，不扩散到全局 LearningSession 模型。 */
export interface ChatSessionListItem extends LearningSession {
  mode: SessionMode;
}
