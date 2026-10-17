// Package learningfeedback turns recent assessment evidence into a verifiable next step.
package learningfeedback

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"mathstudy/backend/internal/application/masteryprojection"
	"mathstudy/backend/internal/platform/numutil"
	"mathstudy/backend/internal/platform/questiondedupe"
)

const (
	WindowDays             = 30
	AttemptLimit           = 20
	AssistanceHinted       = "hinted"
	AssistanceNoneRecorded = "no_recorded_hint"
	AssistanceUnknown      = "unknown"
)

// Reader supplies student-owned, immutable assessment facts in one snapshot.
type Reader interface {
	ReadLearningFeedback(context.Context, string, []string, time.Time) (map[string]Snapshot, error)
}

// RecentReader includes concepts with assessment evidence even before a DKT measurement exists.
type RecentReader interface {
	ReadRecentLearningFeedback(context.Context, string, time.Time) ([]Snapshot, error)
}

type Attempt struct {
	ID               string    `json:"id"`
	ContentID        string    `json:"content_id"`
	Body             string    `json:"body"`
	Correct          bool      `json:"correct"`
	FirstAttempt     bool      `json:"first_attempt"`
	MasteryWeight    float64   `json:"mastery_weight"`
	AssistanceStatus string    `json:"assistance_status"`
	ProcessStatus    string    `json:"process_status"`
	ErrorType        string    `json:"error_type"`
	ErrorSubtype     string    `json:"error_subtype"`
	SubmittedAt      time.Time `json:"submitted_at"`
}

type Snapshot struct {
	ConceptID        string     `json:"concept_id"`
	Name             string     `json:"name"`
	Mastery          *float64   `json:"mastery"`
	Confidence       float64    `json:"confidence"`
	LifetimeAttempts int        `json:"lifetime_attempts"`
	LastAttemptAt    *time.Time `json:"last_attempt_at"`
	Attempts         []Attempt  `json:"attempts"`
}

// Feedback separates work completed from evidence of independent and delayed success.
// Thresholds are transparent teaching heuristics, not calibrated learning probabilities.
type Feedback struct {
	EvidenceVersion           int       `json:"evidence_version"`
	ConceptID                 string    `json:"concept_id"`
	ConceptName               string    `json:"concept_name"`
	Stage                     string    `json:"stage"`
	Label                     string    `json:"label"`
	Reason                    string    `json:"reason"`
	NextStep                  string    `json:"next_step"`
	SuccessCriterion          string    `json:"success_criterion"`
	RecommendedDifficulty     float64   `json:"recommended_difficulty"`
	EstimatedMastery          *float64  `json:"estimated_mastery"`
	Confidence                float64   `json:"confidence"`
	RecentAttempts            int       `json:"recent_attempts"`
	IndependentAttempts       int       `json:"independent_attempts"`
	IndependentCorrect        int       `json:"independent_correct"`
	HintedAttempts            int       `json:"hinted_attempts"`
	HintedCorrect             int       `json:"hinted_correct"`
	UnknownAssistanceAttempts int       `json:"unknown_assistance_attempts"`
	DelayedCorrect            int       `json:"delayed_correct"`
	RecentAccuracy            *float64  `json:"recent_accuracy"`
	DominantError             string    `json:"dominant_error,omitempty"`
	FocusError                string    `json:"focus_error,omitempty"`
	WindowDays                int       `json:"window_days"`
	AsOf                      time.Time `json:"as_of"`
}

// Build never writes mastery or treats repeated answers as independent verification.
func Build(snapshot Snapshot, now time.Time) Feedback {
	f := Feedback{
		EvidenceVersion: 2,
		ConceptID:       snapshot.ConceptID, ConceptName: snapshot.Name,
		Stage: "diagnostic", Label: "先做诊断", WindowDays: WindowDays, AsOf: now.UTC(),
		Reason:                "未记录题目提示的新题首答证据不足，暂不判断已经掌握或薄弱。",
		NextStep:              "先尝试一道基础新题，写出关键步骤；需要时仍可求助，提示辅助作答会单独统计。",
		SuccessCriterion:      "先积累至少3道不同新题、未记录本平台题目提示的首次作答，再确定下一步。",
		RecommendedDifficulty: 0.35,
	}
	if snapshot.Mastery != nil && !math.IsNaN(*snapshot.Mastery) && !math.IsInf(*snapshot.Mastery, 0) && snapshot.LastAttemptAt != nil && !snapshot.LastAttemptAt.After(now) && snapshot.LifetimeAttempts > 0 {
		value := numutil.RoundPlaces(masteryprojection.Current(*snapshot.Mastery, snapshot.LastAttemptAt, now), 4)
		f.EstimatedMastery = &value
		if !math.IsNaN(snapshot.Confidence) && !math.IsInf(snapshot.Confidence, 0) {
			f.Confidence = numutil.RoundPlaces(numutil.ClampFloat(snapshot.Confidence, 0, 1), 4)
		}
	}
	attempts := recentAttempts(snapshot.Attempts, now)
	f.RecentAttempts = len(attempts)
	independent := make([]Attempt, 0, len(attempts))
	seenContent := map[string]bool{}
	// Keep the earliest exposure to an identical body in this window. A new ID
	// after a hinted or incorrect answer must not turn that body into a new test.
	firstBodyAttempt := map[string]string{}
	for index := len(attempts) - 1; index >= 0; index-- {
		body := evidenceBodyKey(attempts[index].Body)
		if _, exists := firstBodyAttempt[body]; !exists {
			firstBodyAttempt[body] = attempts[index].ID
		}
	}
	errors := map[string]int{}
	for index, attempt := range attempts {
		if index < 5 && (!attempt.Correct || attempt.ProcessStatus == "incorrect") {
			if kind := canonicalError(attempt.ErrorType); kind != "" {
				errors[kind]++
			}
		}
		body := evidenceBodyKey(attempt.Body)
		if !attempt.FirstAttempt || attempt.ContentID == "" || body == "" || seenContent[attempt.ContentID] || firstBodyAttempt[body] != attempt.ID {
			continue
		}
		seenContent[attempt.ContentID] = true
		switch attempt.AssistanceStatus {
		case AssistanceHinted:
			f.HintedAttempts++
			if attempt.Correct {
				f.HintedCorrect++
			}
			continue
		case AssistanceNoneRecorded:
			if attempt.MasteryWeight != 1 {
				continue
			}
		default:
			f.UnknownAssistanceAttempts++
			continue
		}
		independent = append(independent, attempt)
		if attempt.Correct {
			f.IndependentCorrect++
		}
	}
	f.IndependentAttempts = len(independent)
	for _, kind := range []string{"conceptual", "procedural", "logical", "symbolic"} {
		if errors[kind] > errors[f.DominantError] {
			f.DominantError = kind
		}
	}
	for _, attempt := range attempts[:min(5, len(attempts))] {
		if (!attempt.Correct || attempt.ProcessStatus == "incorrect") && f.DominantError != "" && canonicalError(attempt.ErrorType) == f.DominantError {
			value := []rune(strings.Join(strings.Fields(attempt.ErrorSubtype), " "))
			f.FocusError = string(value[:min(len(value), 80)])
			if f.FocusError != "" {
				break
			}
		}
	}
	if len(independent) > 0 {
		oldest := independent[len(independent)-1].SubmittedAt
		correct, sample := 0, min(5, len(independent))
		for index, attempt := range independent {
			if attempt.Correct && attempt.SubmittedAt.Sub(oldest) >= 24*time.Hour {
				f.DelayedCorrect++
			}
			if index < sample && attempt.Correct {
				correct++
			}
		}
		accuracy := numutil.RoundPlaces(float64(correct)/float64(sample), 4)
		f.RecentAccuracy = &accuracy
	}

	lastEvidenceAt := snapshot.LastAttemptAt
	if len(independent) > 0 {
		lastEvidenceAt = &independent[0].SubmittedAt
	}
	if (len(attempts) > 0 && (!attempts[0].Correct || attempts[0].ProcessStatus == "incorrect")) || (f.RecentAccuracy != nil && len(independent) >= 3 && *f.RecentAccuracy < 0.6) {
		f.Stage, f.Label = "repair", "针对错因巩固"
		f.Reason = "最近作答仍有错误，先修复关键步骤，再验证迁移。"
		f.NextStep = repairInstruction(f.DominantError)
		f.SuccessCriterion = "连续独立做对不同新题后，再间隔至少24小时检验。"
		return f
	}
	if lastEvidenceAt != nil && !lastEvidenceAt.After(now) && now.Sub(*lastEvidenceAt) >= 7*24*time.Hour && snapshot.LifetimeAttempts > 0 {
		f.Stage, f.Label = "retention", "检验保持"
		f.Reason = "至少7天没有新的首答证据，需要用新题复核当前表现。"
		f.NextStep = "先独立完成一道不同情境的基础题，不提前查看提示或解析。"
		f.SuccessCriterion = "首次作答正确后再增加难度；答错则回到对应错因练习。"
		return f
	}
	if len(independent) < 3 {
		if len(attempts) >= 3 {
			f.Reason = fmt.Sprintf("近期%d次练习中有%d道未记录提示的新题首答、%d道提示辅助首答、%d道提示状态未知首答；辅助作答、重复题和未知记录不能替代独立验证。", len(attempts), len(independent), f.HintedAttempts, f.UnknownAssistanceAttempts)
		}
		if f.HintedCorrect > 0 {
			f.Label = "撤去提示再验证"
			f.NextStep = "提示辅助下已有正确作答；换一道同知识点的基础新题，先尝试自行选择方法，再按需请求提示。"
		}
		return f
	}
	f.Stage, f.Label = "consolidate", "巩固解题步骤"
	f.Reason = "已有未记录题目提示的新题首答，正确性还需要稳定。"
	f.NextStep = "用不同表示或条件完成一道新题，检查方法选择和运算步骤。"
	f.SuccessCriterion = "最近5道独立新题至少答对4道，再进行间隔验证。"
	f.RecommendedDifficulty = 0.5
	if f.RecentAccuracy != nil && *f.RecentAccuracy >= 0.8 {
		f.Stage, f.Label = "verify", "等待间隔验证"
		f.Reason = "近期未记录题目提示的新题表现改善，还需要更多题目和跨时间证据。"
		f.NextStep = "选择不同情境的新题独立作答，并在至少24小时后再做新题检验保持。"
		f.SuccessCriterion = "至少5道独立新题、最近5道至少4道正确，且至少2道正确发生在首次证据24小时后。"
		if len(independent) >= 5 && f.DelayedCorrect >= 2 {
			f.Stage, f.Label = "transfer", "尝试迁移应用"
			f.Reason = "未记录题目提示的新题首答与间隔作答均有支持，可以尝试迁移；平台无法确认其他帮助，这仍不是掌握保证。"
			f.NextStep = "保持同一知识点，换一种表示、应用情境或逆向问题，检验方法迁移。"
			f.SuccessCriterion = "迁移题首次独立答对且能解释关键步骤；失败则回到错因巩固。"
			f.RecommendedDifficulty = 0.65
		}
	}
	return f
}

// evidenceBodyKey shares the conservative equivalence rules used at submission.
func evidenceBodyKey(body string) string {
	if key := questiondedupe.DerivativeKey(body); key != "" {
		return key
	}
	return strings.Join(strings.Fields(strings.ToLower(body)), "")
}

// AvoidBodies gives generators a bounded history without answers or student text.
func AvoidBodies(snapshot Snapshot, now time.Time) []string {
	result := make([]string, 0, AttemptLimit)
	for _, attempt := range recentAttempts(snapshot.Attempts, now) {
		if body := strings.TrimSpace(attempt.Body); body != "" {
			result = append(result, body)
		}
	}
	return result
}

func recentAttempts(input []Attempt, now time.Time) []Attempt {
	result := make([]Attempt, 0, min(len(input), AttemptLimit))
	start := now.Add(-WindowDays * 24 * time.Hour)
	for _, attempt := range input {
		if attempt.SubmittedAt.Before(start) || attempt.SubmittedAt.After(now) || attempt.SubmittedAt.IsZero() {
			continue
		}
		result = append(result, attempt)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].SubmittedAt.Equal(result[j].SubmittedAt) {
			return result[i].ID > result[j].ID
		}
		return result[i].SubmittedAt.After(result[j].SubmittedAt)
	})
	return result[:min(len(result), AttemptLimit)]
}

func canonicalError(kind string) string {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "conceptual":
		return "conceptual"
	case "procedural":
		return "procedural"
	case "logical":
		return "logical"
	case "symbolic", "calculation":
		return "symbolic"
	default:
		return ""
	}
}

func repairInstruction(kind string) string {
	switch kind {
	case "conceptual":
		return "通过概念辨析或反例区分易混条件，并解释选择理由。"
	case "procedural":
		return "先标出方法和关键步骤，再完成一道检查漏步、次序或法则使用的新题。"
	case "logical":
		return "检查定理适用条件、推理方向或反例，避免仅重复计算。"
	case "symbolic":
		return "用短计算检验符号、系数、括号或边界项，并安排可自检的步骤。"
	default:
		return "完成一道短步骤新题，定位首个错误步骤后再独立作答。"
	}
}
