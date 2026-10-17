package questiondedupe

import (
	"regexp"
	"strings"
)

var derivativeDefinition = regexp.MustCompile(`(?:([fgh])\(([xtu])\)|y)=([0-9xtu+*/^().{}-]+)`)
var derivativePrefix = regexp.MustCompile(`^(设|已知|求)?(函数)?$`)
var derivativeValue = regexp.MustCompile(`^,?(?:求|计算)([fgh])'\(([+-]?[0-9]+(?:\.[0-9]+)?)\)(?:的值)?\.?$`)
var derivativePoint = regexp.MustCompile(`^,?(?:求|计算)?(?:在)?([xtu])=([+-]?[0-9]+(?:\.[0-9]+)?)(?:处的?|的)?导数(?:值)?\.?$`)
var polynomialExpression = regexp.MustCompile(`^[0-9x+*/^().{}-]+$`)

// DerivativeKey recognizes only an explicit arithmetic function and its first
// derivative at a numeric point. Every word outside that contract must match;
// extra conditions, other goals and ambiguous notation fall back to text matching.
// It deliberately does not use fuzzy text similarity as mathematical equivalence.
func DerivativeKey(body string) string {
	text := strings.Join(strings.Fields(strings.ToLower(body)), "")
	text = strings.NewReplacer("，", ",", "。", "", "？", "", "?", "", "$", "",
		"′", "'", "²", "^2", "³", "^3", `\left`, "", `\right`, "").Replace(text)
	matches := derivativeDefinition.FindAllStringSubmatchIndex(text, -1)
	if len(matches) != 1 {
		return ""
	}
	match := matches[0]
	if !derivativePrefix.MatchString(text[:match[0]]) {
		return ""
	}
	definition := derivativeDefinition.FindStringSubmatch(text)
	variable, point := definition[2], ""
	suffix := text[match[1]:]
	if target := derivativeValue.FindStringSubmatch(suffix); target != nil && target[1] == definition[1] {
		point = target[2]
	} else if target := derivativePoint.FindStringSubmatch(suffix); target != nil && (variable == "" || variable == target[1]) {
		variable, point = target[1], target[2]
	}
	if variable == "" || point == "" {
		return ""
	}
	expression := strings.ReplaceAll(definition[3], variable, "x")
	if !strings.Contains(expression, "x") || !polynomialExpression.MatchString(expression) {
		return ""
	}
	return "derivative-at-v1:" + expression + ":" + point
}
