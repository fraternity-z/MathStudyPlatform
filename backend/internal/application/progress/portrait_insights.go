package progress

import (
	"context"
	"errors"
	"sort"
	"time"

	"mathstudy/backend/internal/application/learningfeedback"
	"mathstudy/backend/internal/application/learningrange"
	"mathstudy/backend/internal/application/masteryprojection"
	"mathstudy/backend/internal/platform/numutil"
	"mathstudy/backend/internal/platform/timefmt"
)

const (
	portraitMinClassSize        = 5
	portraitMinAccuracyAttempts = 10
	portraitMinTopicAttempts    = 5
	portraitMinTopicConfidence  = 0.3

	comparisonBasisUnavailable    = "unavailable"
	comparisonBasisAllClassmates  = "all_classmates"
	comparisonBasisEligibleSample = "eligible_sample"
)

// ErrInvalidPortraitRange indicates that a portrait insight range is unsupported.
var ErrInvalidPortraitRange = errors.New("invalid portrait range")

// StudentAttemptInsight stores fair, teacher-owned activity metrics for one comparison window.
type StudentAttemptInsight struct {
	AttemptCount int
	CorrectCount int
	StudySeconds int
	ActiveDays   int
}

// StudentMasteryInsight stores one student's current DKT state for class comparison.
type StudentMasteryInsight struct {
	StudentID     string
	ConceptID     string
	Mastery       float64
	Confidence    float64
	AttemptCount  int
	LastAttemptAt *time.Time
}

// PortraitInsightsResponse is the structured, non-AI interpretation shown below learning statistics.
type PortraitInsightsResponse struct {
	Range         PortraitRange        `json:"range"`
	Metrics       []PortraitMetric     `json:"metrics"`
	Strengths     []PortraitTopic      `json:"strengths"`
	Improvements  []PortraitTopic      `json:"improvements"`
	Observations  []PortraitTopic      `json:"observations"`
	Actions       []PortraitAction     `json:"actions"`
	ClassContext  PortraitClassContext `json:"class_context"`
	DataUpdatedAt string               `json:"data_updated_at"`
}

// PortraitRange identifies the common activity window used by personal and class metrics.
type PortraitRange struct {
	Type      string `json:"type"`
	StartDate string `json:"start_date"`
	EndDate   string `json:"end_date"`
}

// PortraitMetric contains one comparable activity dimension.
type PortraitMetric struct {
	Key               string   `json:"key"`
	Label             string   `json:"label"`
	PersonalValue     float64  `json:"personal_value"`
	ComparisonValue   *float64 `json:"comparison_value"`
	Unit              string   `json:"unit"`
	ClassAverage      *float64 `json:"class_average"`
	ExceededPercent   *float64 `json:"exceeded_percent"`
	SampleSize        int      `json:"sample_size"`
	Available         bool     `json:"available"`
	ComparisonBasis   string   `json:"comparison_basis"`
	UnavailableReason string   `json:"unavailable_reason,omitempty"`
}

// PortraitTopic describes a current knowledge strength or priority gap.
type PortraitTopic struct {
	ConceptID         string                     `json:"concept_id"`
	Name              string                     `json:"name"`
	Mastery           *float64                   `json:"mastery"`
	ClassAverage      *float64                   `json:"class_average"`
	ExceededPercent   *float64                   `json:"exceeded_percent"`
	AttemptCount      int                        `json:"attempt_count"`
	Confidence        float64                    `json:"confidence"`
	SampleSize        int                        `json:"sample_size"`
	Available         bool                       `json:"available"`
	ComparisonBasis   string                     `json:"comparison_basis"`
	UnavailableReason string                     `json:"unavailable_reason,omitempty"`
	LearningFeedback  *learningfeedback.Feedback `json:"learning_feedback,omitempty"`
}

// PortraitClassContext explains the comparison cohort without exposing peer identities.
type PortraitClassContext struct {
	InClass        bool `json:"in_class"`
	ClassSize      int  `json:"class_size"`
	ActiveStudents int  `json:"active_students"`
}

// GetPortraitInsights turns learning statistics into deterministic strengths, gaps and next actions.
func (s *Service) GetPortraitInsights(ctx context.Context, userID string, rangeType string) (PortraitInsightsResponse, error) {
	if rangeType == "" {
		rangeType = string(learningrange.Week)
	}
	kind, err := learningrange.Parse(rangeType)
	if err != nil {
		return PortraitInsightsResponse{}, ErrInvalidPortraitRange
	}
	now := s.now()
	window := learningrange.Resolve(now, kind)
	studentIDs, teacherID, inClass, err := s.repo.ListClassStudentIDs(ctx, userID)
	if err != nil {
		return PortraitInsightsResponse{}, err
	}
	classSize := len(studentIDs)
	if !inClass {
		studentIDs = []string{userID}
	}

	personalActivity, err := s.repo.AttemptInsightsForStudents(ctx, "", []string{userID}, window.Start.UTC(), window.End.UTC())
	if err != nil {
		return PortraitInsightsResponse{}, err
	}
	comparisonActivity := map[string]StudentAttemptInsight{}
	if inClass {
		comparisonActivity, err = s.repo.AttemptInsightsForStudents(ctx, teacherID, studentIDs, window.Start.UTC(), window.End.UTC())
		if err != nil {
			return PortraitInsightsResponse{}, err
		}
	}
	states, err := s.repo.MasteryStatesForStudents(ctx, studentIDs)
	if err != nil {
		return PortraitInsightsResponse{}, err
	}
	actionProgresses, err := s.repo.ListPortraitActionProgresses(ctx, userID)
	if err != nil {
		return PortraitInsightsResponse{}, err
	}
	conceptIDs := make([]string, 0, len(states)+len(actionProgresses))
	seenConcepts := make(map[string]struct{}, len(states)+len(actionProgresses))
	for _, state := range states {
		if _, ok := seenConcepts[state.ConceptID]; ok {
			continue
		}
		seenConcepts[state.ConceptID] = struct{}{}
		conceptIDs = append(conceptIDs, state.ConceptID)
	}
	for conceptID := range actionProgresses {
		if _, ok := seenConcepts[conceptID]; ok {
			continue
		}
		seenConcepts[conceptID] = struct{}{}
		conceptIDs = append(conceptIDs, conceptID)
	}
	nodeNames, err := s.repo.CourseConceptNames(ctx, conceptIDs)
	if err != nil {
		return PortraitInsightsResponse{}, err
	}
	metrics := portraitMetrics(userID, studentIDs, personalActivity, comparisonActivity, inClass)
	strengths, improvements, observations := portraitTopics(now, userID, studentIDs, states, nodeNames, inClass)
	if reader, ok := s.repo.(learningfeedback.RecentReader); ok {
		recent, err := reader.ReadRecentLearningFeedback(ctx, userID, now)
		if err != nil {
			return PortraitInsightsResponse{}, err
		}
		strengths, improvements, observations = mergeRecentPortraitTopics(strengths, improvements, observations, recent, nodeNames, now)
	}
	recommendations := improvements
	if len(recommendations) == 0 {
		recommendations = observations
	}
	if len(recommendations) == 0 {
		recommendations = strengths
	}
	actions := portraitActions(recommendations, actionProgresses, nodeNames)
	if len(strengths)+len(improvements)+len(observations) == 0 && len(actionProgresses) == 0 {
		actions = []PortraitAction{{Type: "practice", Title: "开始诊断练习", Description: "选择一个知识点，先用基础新题积累学习证据。", Status: "not_started"}}
	}
	if reader, ok := s.repo.(learningfeedback.Reader); ok {
		ids := []string{}
		seen := map[string]bool{}
		for _, topics := range [][]PortraitTopic{improvements, observations, strengths} {
			for _, topic := range topics {
				if !seen[topic.ConceptID] {
					ids = append(ids, topic.ConceptID)
					seen[topic.ConceptID] = true
				}
			}
		}
		for _, action := range actions {
			if action.ConceptID != nil && !seen[*action.ConceptID] {
				ids = append(ids, *action.ConceptID)
				seen[*action.ConceptID] = true
			}
		}
		snapshots, err := reader.ReadLearningFeedback(ctx, userID, ids, now)
		if err != nil {
			return PortraitInsightsResponse{}, err
		}
		feedbacks := map[string]*learningfeedback.Feedback{}
		for id, snapshot := range snapshots {
			feedback := learningfeedback.Build(snapshot, now)
			feedbacks[id] = &feedback
		}
		for _, topics := range [][]PortraitTopic{strengths, improvements, observations} {
			for index := range topics {
				topics[index].LearningFeedback = feedbacks[topics[index].ConceptID]
			}
		}
		for index := range actions {
			if actions[index].ConceptID != nil {
				actions[index].LearningFeedback = feedbacks[*actions[index].ConceptID]
				if actions[index].LearningFeedback != nil {
					actions[index].Title = actions[index].LearningFeedback.Label + "：" + actions[index].LearningFeedback.ConceptName
					actions[index].Description = actions[index].LearningFeedback.NextStep
				}
			}
		}
	}
	activeStudents := 0
	for _, stat := range comparisonActivity {
		if stat.AttemptCount > 0 {
			activeStudents++
		}
	}

	return PortraitInsightsResponse{
		Range: PortraitRange{
			Type:      string(window.Kind),
			StartDate: timefmt.Date(window.Start),
			EndDate:   timefmt.Date(window.Today),
		},
		Metrics:      metrics,
		Strengths:    strengths,
		Improvements: improvements,
		Observations: observations,
		Actions:      actions,
		ClassContext: PortraitClassContext{
			InClass:        inClass,
			ClassSize:      classSize,
			ActiveStudents: activeStudents,
		},
		DataUpdatedAt: timefmt.DateTimeRFC3339(window.SnapshotAt),
	}, nil
}

type portraitMetricDefinition struct {
	key             string
	label           string
	unit            string
	currentMinimum  int
	peerMinimum     int
	includeAllPeers bool
	basis           string
	value           func(StudentAttemptInsight) float64
}

func portraitMetrics(
	userID string,
	studentIDs []string,
	personalStats map[string]StudentAttemptInsight,
	comparisonStats map[string]StudentAttemptInsight,
	inClass bool,
) []PortraitMetric {
	definitions := []portraitMetricDefinition{
		{key: "accuracy", label: "正确率", unit: "%", currentMinimum: portraitMinAccuracyAttempts, peerMinimum: portraitMinAccuracyAttempts, basis: comparisonBasisEligibleSample, value: func(stat StudentAttemptInsight) float64 {
			return numutil.Percent(stat.AttemptCount, stat.CorrectCount)
		}},
		{key: "practice", label: "练习数量", unit: "题", includeAllPeers: true, basis: comparisonBasisAllClassmates, value: func(stat StudentAttemptInsight) float64 {
			return float64(stat.AttemptCount)
		}},
		{key: "study_time", label: "学习时长", unit: "分钟", includeAllPeers: true, basis: comparisonBasisAllClassmates, value: func(stat StudentAttemptInsight) float64 {
			return float64(stat.StudySeconds) / 60
		}},
		{key: "active_days", label: "活跃天数", unit: "天", includeAllPeers: true, basis: comparisonBasisAllClassmates, value: func(stat StudentAttemptInsight) float64 {
			return float64(stat.ActiveDays)
		}},
	}
	personalStat := personalStats[userID]
	studentStat := comparisonStats[userID]
	metrics := make([]PortraitMetric, 0, len(definitions))
	for _, definition := range definitions {
		metric := PortraitMetric{
			Key:             definition.key,
			Label:           definition.label,
			PersonalValue:   numutil.RoundPlaces(definition.value(personalStat), 1),
			Unit:            definition.unit,
			Available:       false,
			ComparisonBasis: comparisonBasisUnavailable,
		}
		if !inClass {
			metric.UnavailableReason = "未加入班级"
			metrics = append(metrics, metric)
			continue
		}
		if studentStat.AttemptCount < definition.currentMinimum {
			metric.UnavailableReason = "课程练习数据不足"
			metrics = append(metrics, metric)
			continue
		}
		comparisonValue := numutil.RoundPlaces(definition.value(studentStat), 1)
		metric.ComparisonValue = &comparisonValue
		peerValues := make([]float64, 0, len(studentIDs)-1)
		for _, peerID := range studentIDs {
			if peerID == userID {
				continue
			}
			peerStat := comparisonStats[peerID]
			if !definition.includeAllPeers && peerStat.AttemptCount < definition.peerMinimum {
				continue
			}
			peerValues = append(peerValues, definition.value(peerStat))
		}
		metric.SampleSize = len(peerValues)
		if len(peerValues)+1 < portraitMinClassSize {
			metric.UnavailableReason = "班级有效样本不足5人"
			metrics = append(metrics, metric)
			continue
		}
		average, lower := 0.0, 0
		for _, value := range peerValues {
			average += value
			if value < definition.value(studentStat) {
				lower++
			}
		}
		average = numutil.RoundPlaces(average/float64(len(peerValues)), 1)
		exceeded := numutil.RoundPlaces(float64(lower)/float64(len(peerValues))*100, 1)
		metric.ClassAverage = &average
		metric.ExceededPercent = &exceeded
		metric.Available = true
		metric.ComparisonBasis = definition.basis
		metrics = append(metrics, metric)
	}
	return metrics
}

func portraitTopics(now time.Time, userID string, studentIDs []string, states []StudentMasteryInsight, names map[string]string, inClass bool) ([]PortraitTopic, []PortraitTopic, []PortraitTopic) {
	byConcept := map[string]map[string]StudentMasteryInsight{}
	for _, state := range states {
		if _, ok := byConcept[state.ConceptID]; !ok {
			byConcept[state.ConceptID] = map[string]StudentMasteryInsight{}
		}
		state.Mastery = masteryprojection.Current(state.Mastery, state.LastAttemptAt, now)
		byConcept[state.ConceptID][state.StudentID] = state
	}

	topics := make([]PortraitTopic, 0)
	observations := make([]PortraitTopic, 0)
	for conceptID, studentStates := range byConcept {
		current, ok := studentStates[userID]
		if !ok || current.AttemptCount == 0 {
			continue
		}
		name, exists := names[conceptID]
		if !exists || name == "" {
			continue
		}
		mastery := numutil.RoundPlaces(current.Mastery, 4)
		topic := PortraitTopic{
			ConceptID:       conceptID,
			Name:            name,
			Mastery:         &mastery,
			AttemptCount:    current.AttemptCount,
			Confidence:      numutil.RoundPlaces(current.Confidence, 4),
			ComparisonBasis: comparisonBasisUnavailable,
		}
		isReliable := current.AttemptCount >= portraitMinTopicAttempts && current.Confidence >= portraitMinTopicConfidence
		if isReliable && inClass {
			peerValues := make([]float64, 0, len(studentIDs)-1)
			for _, peerID := range studentIDs {
				if peerID == userID {
					continue
				}
				peer, ok := studentStates[peerID]
				if !ok || peer.AttemptCount < portraitMinTopicAttempts || peer.Confidence < portraitMinTopicConfidence {
					continue
				}
				peerValues = append(peerValues, peer.Mastery)
			}
			topic.SampleSize = len(peerValues)
			if len(peerValues)+1 >= portraitMinClassSize {
				average, lower := 0.0, 0
				for _, value := range peerValues {
					average += value
					if value < current.Mastery {
						lower++
					}
				}
				average = numutil.RoundPlaces(average/float64(len(peerValues)), 4)
				exceeded := numutil.RoundPlaces(float64(lower)/float64(len(peerValues))*100, 1)
				topic.ClassAverage = &average
				topic.ExceededPercent = &exceeded
				topic.Available = true
				topic.ComparisonBasis = comparisonBasisEligibleSample
			} else {
				topic.UnavailableReason = "班级有效样本不足5人"
			}
		} else if isReliable {
			topic.UnavailableReason = "未加入班级"
		}
		if isReliable {
			topics = append(topics, topic)
		} else {
			observations = append(observations, topic)
		}
	}

	sort.Slice(topics, func(i, j int) bool {
		if *topics[i].Mastery == *topics[j].Mastery {
			return topics[i].Name < topics[j].Name
		}
		return *topics[i].Mastery > *topics[j].Mastery
	})
	strengths := make([]PortraitTopic, 0, 3)
	for _, topic := range topics {
		if *topic.Mastery >= 0.75 && len(strengths) < 3 {
			strengths = append(strengths, topic)
		}
	}
	sort.Slice(topics, func(i, j int) bool {
		if *topics[i].Mastery == *topics[j].Mastery {
			return topics[i].Name < topics[j].Name
		}
		return *topics[i].Mastery < *topics[j].Mastery
	})
	improvements := make([]PortraitTopic, 0, 3)
	for _, topic := range topics {
		if *topic.Mastery < 0.75 && len(improvements) < 3 {
			improvements = append(improvements, topic)
		}
	}
	sort.Slice(observations, func(i, j int) bool {
		if observations[i].AttemptCount == observations[j].AttemptCount {
			return observations[i].Name < observations[j].Name
		}
		return observations[i].AttemptCount > observations[j].AttemptCount
	})
	if len(observations) > 3 {
		observations = observations[:3]
	}
	return strengths, improvements, observations
}

func mergeRecentPortraitTopics(strengths, improvements, observations []PortraitTopic, recent []learningfeedback.Snapshot, names map[string]string, now time.Time) ([]PortraitTopic, []PortraitTopic, []PortraitTopic) {
	remove := func(topics []PortraitTopic, id string) []PortraitTopic {
		result := make([]PortraitTopic, 0, len(topics))
		for _, topic := range topics {
			if topic.ConceptID != id {
				result = append(result, topic)
			}
		}
		return result
	}
	repairs := []PortraitTopic{}
	for _, snapshot := range recent {
		feedback := learningfeedback.Build(snapshot, now)
		names[snapshot.ConceptID] = snapshot.Name
		topic := PortraitTopic{ConceptID: snapshot.ConceptID, Name: snapshot.Name,
			Mastery: feedback.EstimatedMastery, Confidence: feedback.Confidence,
			AttemptCount: snapshot.LifetimeAttempts, ComparisonBasis: comparisonBasisUnavailable,
			UnavailableReason: "学习证据不足，暂不提供班级比较", LearningFeedback: &feedback}
		if feedback.Stage == "repair" {
			strengths = remove(strengths, snapshot.ConceptID)
			improvements = remove(improvements, snapshot.ConceptID)
			observations = remove(observations, snapshot.ConceptID)
			repairs = append(repairs, topic)
			continue
		}
		found := false
		for _, topics := range [][]PortraitTopic{strengths, improvements, observations} {
			for _, existing := range topics {
				found = found || existing.ConceptID == snapshot.ConceptID
			}
		}
		if !found {
			observations = append(observations, topic)
		}
	}
	improvements = append(repairs, improvements...)
	return strengths, improvements[:min(3, len(improvements))], observations[:min(3, len(observations))]
}
