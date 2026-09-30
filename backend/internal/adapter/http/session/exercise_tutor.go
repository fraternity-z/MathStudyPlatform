package sessionhttp

import (
	"errors"
	"net/http"

	sessionapp "mathstudy/backend/internal/application/session"
	"mathstudy/backend/internal/platform/httpjson"
)

func (h *Handler) prepareExerciseTutor(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requirePrincipal(w, r)
	if !ok {
		return
	}
	var request struct {
		ExerciseID string `json:"exercise_id"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	if len(request.ExerciseID) != 36 {
		writeSessionError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "题目标识格式错误")
		return
	}
	response, err := h.service.PrepareExerciseTutor(r.Context(), principal.UserID, request.ExerciseID)
	if err != nil {
		h.writeExerciseTutorError(w, err)
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) exerciseTutor(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requirePrincipal(w, r)
	if !ok {
		return
	}
	response, err := h.service.GetExerciseTutor(r.Context(), r.PathValue("session_id"), principal.UserID)
	if err != nil {
		h.writeExerciseTutorError(w, err)
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) exerciseHint(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requirePrincipal(w, r)
	if !ok {
		return
	}
	stream := &chatSSEWriter{response: w}
	result, err := h.service.StartExerciseHint(r.Context(), r.PathValue("session_id"), principal.UserID, stream.callbacks())
	if err != nil {
		h.writeChatStreamFailure(stream, err, "exercise hint failed")
		return
	}
	if err := stream.writeResult(result); err != nil {
		h.logger.Debug("exercise hint stream closed")
	}
}

func (h *Handler) writeExerciseTutorError(w http.ResponseWriter, err error) {
	if errors.Is(err, sessionapp.ErrNotFound) || errors.Is(err, sessionapp.ErrTutorExerciseUnavailable) {
		writeSessionError(w, http.StatusNotFound, "NOT_FOUND", "题目或辅导会话不存在，或无权访问")
		return
	}
	h.logSessionError("exercise tutor failed", err)
	writeSessionError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "题目辅导暂时不可用，请重试")
}
