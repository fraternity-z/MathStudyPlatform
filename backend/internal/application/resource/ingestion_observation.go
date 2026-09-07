package resource

import (
	"fmt"
	"strings"
	"sync/atomic"
	"time"
)

var ingestionStageNames = [...]string{"claim", "object", "parser", "chunker", "embedding", "vector", "publish"}
var ingestionStageBuckets = [...]float64{0.01, 0.1, 0.5, 1, 5, 15, 60, 120, 600}

type ingestionStageMetrics struct {
	counts   [7]atomic.Uint64
	failures [7]atomic.Uint64
	micros   [7]atomic.Uint64
	buckets  [7][9]atomic.Uint64
}

func (m *ingestionStageMetrics) observe(stage int, started time.Time, err error) {
	duration := time.Since(started)
	m.counts[stage].Add(1)
	m.micros[stage].Add(uint64(max(0, duration.Microseconds())))
	if err != nil {
		m.failures[stage].Add(1)
	}
	for i, bound := range ingestionStageBuckets {
		if duration.Seconds() <= bound {
			m.buckets[stage][i].Add(1)
		}
	}
}

func (m *ingestionStageMetrics) text() string {
	var b strings.Builder
	b.WriteString("# TYPE msp_resource_ingestion_stage_duration_seconds histogram\n# TYPE msp_resource_ingestion_stage_failures_total counter\n")
	for stage, name := range ingestionStageNames {
		for i, bound := range ingestionStageBuckets {
			fmt.Fprintf(&b, "msp_resource_ingestion_stage_duration_seconds_bucket{stage=%q,le=%q} %d\n", name, fmt.Sprint(bound), m.buckets[stage][i].Load())
		}
		fmt.Fprintf(&b, "msp_resource_ingestion_stage_duration_seconds_bucket{stage=%q,le=\"+Inf\"} %d\n", name, m.counts[stage].Load())
		fmt.Fprintf(&b, "msp_resource_ingestion_stage_duration_seconds_count{stage=%q} %d\n", name, m.counts[stage].Load())
		fmt.Fprintf(&b, "msp_resource_ingestion_stage_duration_seconds_sum{stage=%q} %.6f\n", name, float64(m.micros[stage].Load())/1e6)
		fmt.Fprintf(&b, "msp_resource_ingestion_stage_failures_total{stage=%q} %d\n", name, m.failures[stage].Load())
	}
	return b.String()
}
