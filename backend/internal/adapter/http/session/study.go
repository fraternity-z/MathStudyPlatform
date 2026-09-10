package sessionhttp

import (
	"errors"
	"net/http"

	sessionapp "mathstudy/backend/internal/application/session"
	"mathstudy/backend/internal/platform/httpjson"
)

func (h *Handler) study(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requirePrincipal(w, r)
	if !ok {
		return
	}
	progress, err := h.service.GetStudyProgress(r.Context(), r.PathValue("session_id"), principal.UserID)
	if err != nil {
		h.writeStudyError(w, err)
		return
	}
	httpjson.Write(w, http.StatusOK, progress)
}

func (h *Handler) updateStudy(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requirePrincipal(w, r)
	if !ok {
		return
	}
	var request sessionapp.StudyUpdate
	if !decodeRequest(w, r, &request) {
		return
	}
	progress, err := h.service.UpdateStudyProgress(r.Context(), r.PathValue("session_id"), principal.UserID, request)
	if err != nil {
		h.writeStudyError(w, err)
		return
	}
	httpjson.Write(w, http.StatusOK, progress)
}

func (h *Handler) writeStudyError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, sessionapp.ErrNotFound):
		writeSessionError(w, http.StatusNotFound, "NOT_FOUND", "会话不存在或已结束")
	case errors.Is(err, sessionapp.ErrInvalidStudy):
		writeSessionError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "请检查学习主题、基础与操作")
	case errors.Is(err, sessionapp.ErrStudyConflict):
		writeSessionError(w, http.StatusConflict, "STUDY_PROGRESS_CONFLICT", "进度已变化，或本环节尚未完成对话。理解检查需先作答并获得反馈，请刷新后继续")
	default:
		h.logSessionError("study progress failed", err)
		writeSessionError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "学习进度暂时不可用，请重试")
	}
}
