package exercise

import (
	"strconv"
	"strings"

	"mathstudy/backend/internal/platform/metautil"
)

// normalizeSolutionChoiceAnswer accepts an explicitly labelled solver answer
// only when its label and text identify the same option. Student submissions
// retain their existing, stricter choice matching rules.
func normalizeSolutionChoiceAnswer(exercise Exercise, answer string) string {
	if metautil.String(exercise.Meta, "type") != QuestionTypeMultipleChoice {
		return answer
	}
	options := metautil.StringSlice(exercise.Meta, "options")
	if option, ok := canonicalStudentOption(options, answer); ok {
		return option
	}
	label, content, ok := strings.Cut(strings.ReplaceAll(answer, "：", ":"), ":")
	if !ok {
		return answer
	}
	label = strings.TrimSpace(label)
	switch {
	case strings.HasPrefix(label, "选项"):
		label = strings.TrimSpace(strings.TrimPrefix(label, "选项"))
	case strings.HasPrefix(strings.ToLower(label), "option "):
		label = strings.TrimSpace(label[len("option "):])
	default:
		return answer
	}
	option, matched := optionFromLabel(options, label)
	if !matched {
		index, err := strconv.Atoi(label)
		if err != nil || strconv.Itoa(index) != label || index < 1 || index > len(options) {
			return answer
		}
		option = options[index-1]
	}
	if normalizeAnswer(content) != normalizeAnswer(option) {
		return answer
	}
	return option
}
