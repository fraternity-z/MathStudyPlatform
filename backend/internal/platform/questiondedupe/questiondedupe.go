// Package questiondedupe provides conservative body-level duplicate checks for exercises.
package questiondedupe

import (
	"strings"
	"unicode"
)

const (
	minimumComparableRunes    = 16
	trigramDuplicateThreshold = 0.92
	runeDuplicateThreshold    = 0.96
)

// IsDuplicate reports whether candidate is an exact or near duplicate of a prior question body.
func IsDuplicate(candidate string, previous []string) bool {
	candidateNormalized := Normalize(candidate)
	structuralKey := DerivativeKey(candidate)
	if candidateNormalized == "" {
		return false
	}
	for _, item := range previous {
		if structuralKey != "" && structuralKey == DerivativeKey(item) {
			return true
		}
		if similarNormalized(candidateNormalized, Normalize(item)) {
			return true
		}
	}
	return false
}

// Normalize removes presentation-only differences while preserving mathematical operators.
func Normalize(value string) string {
	var builder strings.Builder
	builder.Grow(len(value))
	for _, runeValue := range strings.ToLower(strings.TrimSpace(value)) {
		if unicode.IsSpace(runeValue) || unicode.IsControl(runeValue) || unicode.Is(unicode.Cf, runeValue) {
			continue
		}
		if unicode.IsPunct(runeValue) && !isMathematicalPunctuation(runeValue) {
			continue
		}
		builder.WriteRune(canonicalMathematicalPunctuation(runeValue))
	}
	return builder.String()
}

func isMathematicalPunctuation(value rune) bool {
	switch value {
	case '-', '−', '–', '—', '*', '×', '＊', '/', '\\', '／', '÷', '%', '％', '^', '_',
		'=', '＝', '<', '>', '＜', '＞', '≤', '≥', '≠', '≈', '|', ':', ';',
		'.', ',', '，', '(', ')', '[', ']', '{', '}', '（', '）', '［', '］', '｛', '｝',
		'!', '\'', '′', '″':
		return true
	default:
		return false
	}
}

func canonicalMathematicalPunctuation(value rune) rune {
	switch value {
	case '−', '–', '—':
		return '-'
	case '×', '＊':
		return '*'
	case '／', '÷':
		return '/'
	case '＝':
		return '='
	case '＜':
		return '<'
	case '＞':
		return '>'
	case '（':
		return '('
	case '）':
		return ')'
	case '［':
		return '['
	case '］':
		return ']'
	case '｛':
		return '{'
	case '｝':
		return '}'
	default:
		return value
	}
}

func similarNormalized(left, right string) bool {
	if left == "" || right == "" {
		return false
	}
	if left == right {
		return true
	}
	leftRunes := []rune(left)
	rightRunes := []rune(right)
	if len(leftRunes) < minimumComparableRunes || len(rightRunes) < minimumComparableRunes {
		return false
	}
	leftShingles := runeTrigrams(leftRunes)
	rightShingles := runeTrigrams(rightRunes)
	if len(leftShingles) == 0 || len(rightShingles) == 0 {
		return false
	}
	shared := 0
	for shingle := range leftShingles {
		if _, ok := rightShingles[shingle]; ok {
			shared++
		}
	}
	dice := float64(2*shared) / float64(len(leftShingles)+len(rightShingles))
	if dice >= trigramDuplicateThreshold {
		return true
	}
	return runeDice(leftRunes, rightRunes) >= runeDuplicateThreshold
}

func runeTrigrams(value []rune) map[string]struct{} {
	if len(value) < 3 {
		return nil
	}
	result := make(map[string]struct{}, len(value)-2)
	for index := 0; index+3 <= len(value); index++ {
		result[string(value[index:index+3])] = struct{}{}
	}
	return result
}

func runeDice(left, right []rune) float64 {
	counts := make(map[rune]int, len(left))
	for _, runeValue := range left {
		counts[runeValue]++
	}
	shared := 0
	for _, runeValue := range right {
		if counts[runeValue] > 0 {
			shared++
			counts[runeValue]--
		}
	}
	return float64(2*shared) / float64(len(left)+len(right))
}
