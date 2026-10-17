package einoagent

import (
	"context"
	"log/slog"
	"time"

	exerciseapp "mathstudy/backend/internal/application/exercise"
	sessionapp "mathstudy/backend/internal/application/session"
)

// Retry only a malformed structured response, once, within the original deadline.
// No provider payload, student text or credentials are logged or echoed as repair instructions.
func generateSolverJSON[T any](ctx context.Context, agent sessionapp.ChatAgent, stage, prompt string, parse func(string) (T, error)) (T, error) {
	var zero T
	for attempt := 1; attempt <= 2; attempt++ {
		if err := ctx.Err(); err != nil {
			return zero, err
		}
		message := prompt
		if attempt > 1 {
			message += "\n上次输出未通过结构校验。请重新独立求解并严格遵守上述 JSON 合同，补齐必填字段；字符串中的 LaTeX 反斜杠必须按 JSON 规则转义，不要输出 Markdown。不得为满足格式而猜测数学结论。"
		}
		started := time.Now()
		output, err := agent.Generate(ctx, sessionapp.ChatAgentInput{Message: message})
		outcome := "success"
		if err != nil {
			outcome = "upstream_error"
			if ctx.Err() != nil {
				outcome = "cancelled_or_timeout"
			}
			slog.InfoContext(ctx, "math solver stage", "stage", stage, "attempt", attempt, "duration_ms", time.Since(started).Milliseconds(), "outcome", outcome)
			return zero, err
		}
		result, parseErr := parse(output.Content)
		if parseErr != nil {
			outcome = "invalid_response"
		}
		slog.InfoContext(ctx, "math solver stage", "stage", stage, "attempt", attempt, "duration_ms", time.Since(started).Milliseconds(), "outcome", outcome)
		if err := ctx.Err(); err != nil {
			return zero, err
		}
		if parseErr == nil {
			return result, nil
		}
	}
	return zero, exerciseapp.ErrMathSolverInvalidResult
}
