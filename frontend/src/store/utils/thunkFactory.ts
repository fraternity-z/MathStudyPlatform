/**
 * Thunk 工厂函数
 *
 * 消除 createAsyncThunk 中重复的 try-catch 模式
 */

import { createAsyncThunk, type AsyncThunk } from '@reduxjs/toolkit';
import { toAppError, type AppError } from '@/libs/http/appError';

/**
 * 创建带有统一错误处理的 AsyncThunk
 *
 * @param typePrefix - Thunk 类型前缀
 * @param payloadCreator - 异步操作函数
 * @param defaultErrorMessage - 默认错误消息
 * @returns AsyncThunk
 *
 * @example
 * ```ts
 * export const fetchUsers = createSafeThunk(
 *   'users/fetch',
 *   async () => await userService.getUsers(),
 *   '获取用户列表失败'
 * );
 * ```
 */
export function createSafeThunk<Returned, ThunkArg = void>(
  typePrefix: string,
  payloadCreator: (arg: ThunkArg) => Promise<Returned>,
  defaultErrorMessage = '操作失败'
): AsyncThunk<Returned, ThunkArg, { rejectValue: AppError }> {
  return createAsyncThunk<Returned, ThunkArg, { rejectValue: AppError }>(
    typePrefix,
    async (arg, { rejectWithValue }) => {
      try {
        return await payloadCreator(arg);
      } catch (error: unknown) {
        return rejectWithValue(toAppError(error, defaultErrorMessage));
      }
    }
  );
}

/**
 * 创建带有 getState 访问的 AsyncThunk
 *
 * @param typePrefix - Thunk 类型前缀
 * @param payloadCreator - 异步操作函数，接收 arg 和 getState
 * @param defaultErrorMessage - 默认错误消息
 * @returns AsyncThunk
 *
 * @example
 * ```ts
 * export const fetchLogs = createSafeThunkWithState<LogsResponse, QueryParams | undefined, RootState>(
 *   'logs/fetch',
 *   async (params, getState) => {
 *     const state = getState();
 *     const queryParams = params || state.logs.queryParams;
 *     return await logService.getLogs(queryParams);
 *   },
 *   '获取日志失败'
 * );
 * ```
 */
export function createSafeThunkWithState<Returned, ThunkArg, State>(
  typePrefix: string,
  payloadCreator: (arg: ThunkArg, getState: () => State) => Promise<Returned>,
  defaultErrorMessage = '操作失败'
): AsyncThunk<Returned, ThunkArg, { rejectValue: AppError; state: State }> {
  return createAsyncThunk<Returned, ThunkArg, { rejectValue: AppError; state: State }>(
    typePrefix,
    async (arg, { rejectWithValue, getState }) => {
      try {
        return await payloadCreator(arg, getState);
      } catch (error: unknown) {
        return rejectWithValue(toAppError(error, defaultErrorMessage));
      }
    }
  );
}
