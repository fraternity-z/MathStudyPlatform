/**
 * 班级管理 API 服务
 *
 * 提供班级创建、查询、加入/退出等功能
 */

import { apiClient } from '@/libs/http/apiClient';
import { logger } from '@/libs/utils/logger';
import type {
  ClassCreateRequest,
  ClassCreateResponse,
  ClassDetailResponse,
  ClassListResponse,
  ClassLookupResponse,
  JoinClassRequest,
  JoinClassResponse,
  LeaveClassResponse,
  DisbandClassResponse,
  RemoveStudentResponse,
  StudentClassResponse,
} from '@/modules/classroom/types/classroom';

const classLogger = logger.createContextLogger('Class');
const BASE_PATH = '/classes';

export const classService = {
  async createClass(data: ClassCreateRequest): Promise<ClassCreateResponse> {
    try {
      const response = await apiClient.post<ClassCreateResponse>(BASE_PATH, data);
      classLogger.info('班级创建成功', { name: data.name });
      return response.data;
    } catch (error) {
      classLogger.error('班级创建失败', error);
      throw error;
    }
  },

  async listTeacherClasses(signal?: AbortSignal): Promise<ClassListResponse> {
    try {
      const response = await apiClient.get<ClassListResponse>(`${BASE_PATH}/teacher`, { signal });
      return response.data;
    } catch (error) {
      if (!signal?.aborted) classLogger.error('获取班级列表失败', error);
      throw error;
    }
  },

  async getTeacherClassDetail(classId: string, signal?: AbortSignal): Promise<ClassDetailResponse> {
    try {
      const response = await apiClient.get<ClassDetailResponse>(
        `${BASE_PATH}/teacher/${classId}`,
        { signal }
      );
      return response.data;
    } catch (error) {
      if (!signal?.aborted) classLogger.error('获取班级详情失败', { classId, error });
      throw error;
    }
  },

  async removeStudent(classId: string, studentId: string): Promise<RemoveStudentResponse> {
    try {
      const response = await apiClient.delete<RemoveStudentResponse>(
        `${BASE_PATH}/teacher/${classId}/students/${studentId}`
      );
      return response.data;
    } catch (error) {
      classLogger.error('移除学生失败', { classId, studentId, error });
      throw error;
    }
  },

  async disbandClass(classId: string): Promise<DisbandClassResponse> {
    try {
      const response = await apiClient.delete<DisbandClassResponse>(
        `${BASE_PATH}/teacher/${classId}`
      );
      return response.data;
    } catch (error) {
      classLogger.error('解散班级失败', { classId, error });
      throw error;
    }
  },

  async lookupClass(code: string, signal?: AbortSignal): Promise<ClassLookupResponse> {
    try {
      const response = await apiClient.get<ClassLookupResponse>(`${BASE_PATH}/lookup`, {
        params: { code },
        signal,
      });
      return response.data;
    } catch (error) {
      if (!signal?.aborted) classLogger.error('查询班级失败', { code, error });
      throw error;
    }
  },

  async joinClass(data: JoinClassRequest): Promise<JoinClassResponse> {
    try {
      const response = await apiClient.post<JoinClassResponse>(
        `${BASE_PATH}/join`,
        data
      );
      return response.data;
    } catch (error) {
      classLogger.error('加入班级失败', { code: data.code, error });
      throw error;
    }
  },

  async leaveClass(): Promise<LeaveClassResponse> {
    try {
      const response = await apiClient.post<LeaveClassResponse>(`${BASE_PATH}/leave`);
      return response.data;
    } catch (error) {
      classLogger.error('退出班级失败', error);
      throw error;
    }
  },

  async getMyClass(signal?: AbortSignal): Promise<StudentClassResponse> {
    try {
      const response = await apiClient.get<StudentClassResponse>(`${BASE_PATH}/me`, { signal });
      return response.data;
    } catch (error) {
      if (!signal?.aborted) classLogger.error('获取当前班级失败', error);
      throw error;
    }
  },
};

export default classService;
