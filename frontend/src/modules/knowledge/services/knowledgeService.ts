/**
 * 知识图谱 API 服务
 *
 * 提供知识图谱数据查询功能
 */

import { apiClient } from '@/libs/http/apiClient';
import { logger } from '@/libs/utils/logger';
import type {
  KnowledgeGraphData,
  KnowledgeGraphFilters,
  KnowledgeGraphResponse,
  LearningGoalResponse,
  LearningPathResponse,
} from '@/modules/knowledge/types/knowledge';

const knowledgeLogger = logger.createContextLogger('Knowledge');
const BASE_PATH = '/progress';

export const knowledgeService = {
  /**
   * 获取知识图谱数据
   *
   * @param filters - 筛选条件（可选）
   * @returns 知识图谱数据
   */
  async getKnowledgeGraph(
    filters?: KnowledgeGraphFilters,
    signal?: AbortSignal,
  ): Promise<KnowledgeGraphData> {
    try {
      const params: Record<string, string> = {};

      if (filters?.chapter) {
        params.chapter = filters.chapter;
      }
      if (filters?.type) {
        params.type = filters.type;
      }
      if (filters?.search) {
        params.search = filters.search;
      }

      const response = await apiClient.get<KnowledgeGraphResponse>(
        `${BASE_PATH}/knowledge-graph`,
        { params, signal }
      );

      knowledgeLogger.info('知识图谱数据获取成功', {
        nodeCount: response.data.nodes.length,
        edgeCount: response.data.edges.length,
      });

      return response.data;
    } catch (error) {
      if (!signal?.aborted) knowledgeLogger.error('知识图谱数据获取失败', error);
      throw error;
    }
  },

  /**
   * 获取章节列表
   *
   * 从后端动态获取所有不重复的章节名称
   */
  async getChapters(signal?: AbortSignal): Promise<string[]> {
    try {
      const response = await apiClient.get<{ chapters: string[] }>(
        `${BASE_PATH}/chapters`,
        { signal },
      );
      return response.data.chapters;
    } catch (error) {
      if (!signal?.aborted) knowledgeLogger.error('章节列表获取失败', error);
      throw error;
    }
  },

  async getLearningGoal(signal?: AbortSignal): Promise<LearningGoalResponse> {
    const response = await apiClient.get<LearningGoalResponse>(
      `${BASE_PATH}/learning-goal`,
      { signal },
    );
    return response.data;
  },

  async setLearningGoal(targetId: string): Promise<LearningGoalResponse> {
    const response = await apiClient.put<LearningGoalResponse>(
      `${BASE_PATH}/learning-goal`,
      { target_id: targetId },
    );
    return response.data;
  },

  async getLearningPath(targetId?: string, signal?: AbortSignal): Promise<LearningPathResponse> {
    const response = await apiClient.get<LearningPathResponse>(
      `${BASE_PATH}/path`,
      {
        params: targetId ? { target: targetId } : undefined,
        signal,
      },
    );
    return response.data;
  },
};

export default knowledgeService;
