package session

import (
	"context"
	"encoding/json"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	"mathstudy/backend/internal/application/masteryprojection"
)

// StudentContextReader reads bounded learning evidence for the authenticated student.
// It must not mutate learning state or include answers, raw attempts, or other users' data.
type StudentContextReader interface {
	ReadStudentContext(context.Context, string, StudentContextRequest) (StudentContextSnapshot, error)
}

// StudentContextRequest carries server-owned selection and snapshot boundaries.
type StudentContextRequest struct {
	Message string
	Topic   string
	AsOf    time.Time
}

// StudentContextSnapshot contains persisted evidence before read-side projection.
type StudentContextSnapshot struct {
	Scope         string                     `json:"scope"`
	Concepts      []StudentConceptState      `json:"concepts"`
	RecentErrors  []StudentRecentError       `json:"recent_errors"`
	Prerequisites []StudentPrerequisiteState `json:"prerequisite_gaps"`
}

// StudentConceptState distinguishes an unobserved concept from a low mastery estimate.
type StudentConceptState struct {
	ConceptID     string     `json:"concept_id"`
	Name          string     `json:"name"`
	Mastery       *float64   `json:"estimated_mastery"`
	Confidence    float64    `json:"confidence"`
	AttemptCount  int        `json:"attempt_count"`
	LastAttemptAt *time.Time `json:"last_attempt_at"`
}

// StudentRecentError intentionally omits free-form explanations and answer content.
type StudentRecentError struct {
	ErrorType    string    `json:"error_type"`
	ConceptNames []string  `json:"concept_names"`
	OccurredAt   time.Time `json:"occurred_at"`
}

// StudentPrerequisiteState follows the learning path's source -> prerequisite direction.
type StudentPrerequisiteState struct {
	TargetID     string              `json:"target_id"`
	TargetName   string              `json:"target_name"`
	Prerequisite StudentConceptState `json:"prerequisite"`
}

// WithStudentContextReader enables read-only learning evidence for tutor turns.
func WithStudentContextReader(reader StudentContextReader) Option {
	return func(service *Service) { service.studentContextReader = reader }
}

const maxStudentContextBytes = 4 << 10

func (s *Service) prepareStudentContext(ctx context.Context, userID string, topic *string, message string, budget int) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if s.agent == nil || s.studentContextReader == nil || budget <= 0 {
		return "", nil
	}
	request := StudentContextRequest{Message: message, AsOf: s.now()}
	if topic != nil {
		request.Topic = *topic
	}
	readCtx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer cancel()
	snapshot, err := s.studentContextReader.ReadStudentContext(readCtx, userID, request)
	if parentErr := ctx.Err(); parentErr != nil {
		return "", parentErr
	}
	if err != nil || readCtx.Err() != nil {
		if s.logger != nil {
			reason := "read_unavailable"
			if readCtx.Err() != nil {
				reason = "read_timeout"
			}
			s.logger.Warn("student context unavailable", "reason", reason)
		}
		return "", nil
	}
	return encodeStudentContext(snapshot, request.AsOf, min(budget, maxStudentContextBytes)), nil
}

func encodeStudentContext(snapshot StudentContextSnapshot, now time.Time, budget int) string {
	if snapshot.Scope != "topic" && snapshot.Scope != "recent_learning" {
		return ""
	}
	clean := StudentContextSnapshot{Scope: snapshot.Scope, Concepts: []StudentConceptState{}, RecentErrors: []StudentRecentError{}, Prerequisites: []StudentPrerequisiteState{}}
	seen := make(map[string]bool)
	for _, concept := range snapshot.Concepts[:min(len(snapshot.Concepts), 6)] {
		item, ok := normalizeStudentConcept(concept, now)
		if ok && !seen[item.ConceptID] {
			clean.Concepts = append(clean.Concepts, item)
			seen[item.ConceptID] = true
		}
	}
	for _, recent := range snapshot.RecentErrors[:min(len(snapshot.RecentErrors), 3)] {
		switch recent.ErrorType {
		case "conceptual", "procedural", "logical", "symbolic", "calculation":
		default:
			continue
		}
		if recent.OccurredAt.IsZero() || recent.OccurredAt.After(now) || recent.OccurredAt.Year() < 1 {
			continue
		}
		names := []string{}
		for _, name := range recent.ConceptNames[:min(len(recent.ConceptNames), 6)] {
			if validStudentText(name, 240) {
				names = append(names, strings.TrimSpace(name))
			}
		}
		if len(names) > 0 {
			recent.ConceptNames = names
			clean.RecentErrors = append(clean.RecentErrors, recent)
		}
	}
	seenGaps := make(map[string]bool)
	for _, gap := range snapshot.Prerequisites[:min(len(snapshot.Prerequisites), 12)] {
		item, ok := normalizeStudentConcept(gap.Prerequisite, now)
		if !ok || !seen[gap.TargetID] || !validStudentText(gap.TargetName, 240) || gap.TargetID == item.ConceptID {
			continue
		}
		if item.Mastery != nil && *item.Mastery >= 0.85 && item.Confidence >= 0.5 {
			continue
		}
		key := gap.TargetID + "\x00" + item.ConceptID
		if seenGaps[key] {
			continue
		}
		seenGaps[key] = true
		gap.Prerequisite = item
		clean.Prerequisites = append(clean.Prerequisites, gap)
		if len(clean.Prerequisites) == 4 {
			break
		}
	}
	for len(clean.Concepts)+len(clean.RecentErrors)+len(clean.Prerequisites) > 0 {
		payload := struct {
			Kind         string    `json:"kind"`
			AsOf         time.Time `json:"as_of"`
			EvidenceNote string    `json:"evidence_note"`
			StudentContextSnapshot
		}{"student_learning_context", now.UTC(), "平台只读估计与历史证据；estimated_mastery=null 表示证据不足，不代表掌握度为零。近期错因仅为最近30天最多3条样本，不代表错误总量。", clean}
		encoded, err := json.Marshal(payload)
		if err == nil && len(encoded) <= budget {
			return string(encoded)
		}
		// Remove whole entries only, preserving valid JSON and UTF-8 at every budget.
		switch {
		case len(clean.Prerequisites) > 0:
			clean.Prerequisites = clean.Prerequisites[:len(clean.Prerequisites)-1]
		case len(clean.RecentErrors) > 0:
			clean.RecentErrors = clean.RecentErrors[:len(clean.RecentErrors)-1]
		default:
			clean.Concepts = clean.Concepts[:len(clean.Concepts)-1]
		}
	}
	return ""
}

func normalizeStudentConcept(value StudentConceptState, now time.Time) (StudentConceptState, bool) {
	if !validStudentText(value.ConceptID, 128) || !validStudentText(value.Name, 240) || value.AttemptCount < 0 {
		return StudentConceptState{}, false
	}
	value.ConceptID = strings.TrimSpace(value.ConceptID)
	value.Name = strings.TrimSpace(value.Name)
	if !validStudentProbability(value.Confidence) {
		value.Confidence = 0
	}
	if value.LastAttemptAt != nil && (value.LastAttemptAt.IsZero() || value.LastAttemptAt.After(now) || value.LastAttemptAt.Year() < 1) {
		value.LastAttemptAt = nil
	}
	if value.AttemptCount == 0 || value.LastAttemptAt == nil || value.Mastery == nil || !validStudentProbability(*value.Mastery) {
		value.Mastery = nil
		value.Confidence = 0
	} else {
		projected := masteryprojection.Current(*value.Mastery, value.LastAttemptAt, now)
		value.Mastery = &projected
	}
	return value, true
}

func validStudentText(value string, maxBytes int) bool {
	return len(value) <= maxBytes && utf8.ValidString(value) && strings.TrimSpace(value) != ""
}

func validStudentProbability(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= 1
}
