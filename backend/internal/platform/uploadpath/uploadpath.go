package uploadpath

import (
	"path"
	"strings"
)

const (
	localURLPrefix    = "/uploads/"
	maxLocalURLLength = 300
)

// IsImagePath reports whether value is a normalized local upload image URL.
func IsImagePath(value string) bool {
	return isLocalUploadPath(value, []string{"images"})
}

// IsResourcePath reports whether value is a normalized local upload document or video URL.
func IsResourcePath(value string) bool {
	return isLocalUploadPath(value, []string{"documents", "videos"})
}

// IsLocalPath reports whether value is any normalized local upload URL.
func IsLocalPath(value string) bool {
	return isLocalUploadPath(value, []string{"images", "documents", "videos"})
}

// IsDocumentPath reports whether value is a normalized local uploaded document URL.
func IsDocumentPath(value string) bool {
	return isLocalUploadPath(value, []string{"documents"})
}

// CleanServablePath validates a path relative to /uploads/ and returns its clean object key.
func CleanServablePath(value string) (string, bool) {
	value = strings.TrimPrefix(value, "/")
	if !isSafeUploadKey(value, []string{"images", "documents", "videos"}) {
		return "", false
	}
	return value, true
}

// IsDocumentKey reports whether key points at a document upload object.
func IsDocumentKey(key string) bool {
	return isSafeUploadKey(key, []string{"documents"})
}

func isLocalUploadPath(value string, prefixes []string) bool {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, localURLPrefix) {
		return false
	}
	return isSafeUploadKey(strings.TrimPrefix(value, localURLPrefix), prefixes)
}

func isSafeUploadKey(key string, prefixes []string) bool {
	if key == "" || len(localURLPrefix)+len(key) > maxLocalURLLength {
		return false
	}
	if strings.HasSuffix(key, "/") || strings.ContainsAny(key, "?#\\%") {
		return false
	}
	cleanKey := strings.TrimPrefix(path.Clean("/"+key), "/")
	if cleanKey != key {
		return false
	}
	for _, prefix := range prefixes {
		if strings.HasPrefix(key, prefix+"/") {
			return true
		}
	}
	return false
}
