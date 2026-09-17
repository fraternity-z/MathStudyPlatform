package session

import (
	"errors"
	"unicode/utf8"
)

var ErrInvalidSessionTitle = errors.New("session title exceeds 36 characters")

func validateSessionTitle(title *string) error {
	if title != nil && utf8.RuneCountInString(*title) > 36 {
		return ErrInvalidSessionTitle
	}
	return nil
}

func sessionTitle(topic string) string {
	characters := []rune(topic)
	if len(characters) > 36 {
		characters = characters[:36]
	}
	return string(characters)
}
