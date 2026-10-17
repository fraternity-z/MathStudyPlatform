package mistake

import (
	"context"
	"math"

	"mathstudy/backend/internal/platform/sliceutil"
)

// MasteryHistory contains the two latest persisted measurements, not a level-based trend.
type MasteryHistory struct {
	Current  float64
	Previous *float64
}

type masteryHistoryReader interface {
	ReadMasteryHistory(context.Context, string, []string) (map[string]MasteryHistory, error)
}

func (s *Service) masteryHistory(ctx context.Context, userID string, contents []Content) (map[string]MasteryHistory, error) {
	reader, ok := s.repo.(masteryHistoryReader)
	if !ok {
		return nil, nil
	}
	ids := []string{}
	for _, content := range contents {
		ids = sliceutil.AppendUniqueNonEmptyStrings(ids, content.ConceptIDs...)
	}
	return reader.ReadMasteryHistory(ctx, userID, ids)
}

func measuredMastery(conceptIDs []string, fallback float64, history map[string]MasteryHistory) MistakeMastery {
	result := MistakeMastery{Current: fallback, Trend: "unknown"}
	if len(conceptIDs) == 0 {
		return result
	}
	current, previous := 0.0, 0.0
	for _, id := range conceptIDs {
		value, ok := history[id]
		if !ok || value.Previous == nil || math.IsNaN(value.Current) || math.IsInf(value.Current, 0) ||
			math.IsNaN(*value.Previous) || math.IsInf(*value.Previous, 0) || value.Current < 0 || value.Current > 1 ||
			*value.Previous < 0 || *value.Previous > 1 {
			return result
		}
		current += value.Current
		previous += *value.Previous
	}
	result.Current = current / float64(len(conceptIDs))
	previous /= float64(len(conceptIDs))
	result.Previous = &previous
	result.Trend = "stable"
	if result.Current-previous > 0.01 {
		result.Trend = "improving"
	}
	if result.Current-previous < -0.01 {
		result.Trend = "declining"
	}
	return result
}
