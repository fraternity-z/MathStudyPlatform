package resource

import "strings"

// appendSearchContext consumes only the final authorization result. Primary hits
// keep their ranking and budget priority; redundant neighbors cannot consume the
// space needed by a later neighbor containing new information.
func appendSearchContext(scope SearchScope, request SearchRequest, fused []fusedSearchCandidate, authorized []AuthorizedSearchChunk, response *SearchResponse) {
	chunks := searchChunkMap(authorized)
	remaining := request.MaxContextBytes
	selected := make([]AuthorizedSearchChunk, 0, len(fused))
	selectedVersions := make(map[string]bool)
	for _, item := range fused {
		if !item.adjacent && len(response.Items) >= request.TopK {
			continue
		}
		if item.adjacent && !selectedVersions[item.candidate.DocumentVersionID] {
			continue
		}
		chunk, ok := chunks[searchKey(item.candidate)]
		if !ok || strings.TrimSpace(chunk.Content) == "" {
			continue
		}
		if item.adjacent && searchContextContains(selected, chunk) {
			continue
		}
		used := searchChunkBytes(chunk)
		if used > remaining {
			continue
		}
		remaining -= used
		selected = append(selected, chunk)
		if item.adjacent {
			response.Adjacent = append(response.Adjacent, searchHit(scope, chunk, item.score, item.sources()))
		} else {
			response.Items = append(response.Items, searchHit(scope, chunk, item.score, item.sources()))
			selectedVersions[item.candidate.DocumentVersionID] = true
		}
	}
}

func searchContextContains(selected []AuthorizedSearchChunk, candidate AuthorizedSearchChunk) bool {
	for _, chunk := range selected {
		if chunk.Candidate.ResourceID == candidate.Candidate.ResourceID &&
			chunk.Candidate.DocumentVersionID == candidate.Candidate.DocumentVersionID &&
			chunk.Candidate.Generation == candidate.Candidate.Generation &&
			strings.Contains(chunk.Content, candidate.Content) {
			return true
		}
	}
	return false
}
