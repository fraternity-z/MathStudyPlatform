package middleware

import (
	"compress/gzip"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"mathstudy/backend/internal/platform/metrics"
)

type responseKey struct{}

const maxRequestIDLength = 128

var (
	readRequestIDRandom     = rand.Read
	requestIDFallbackSerial atomic.Uint64
	gzipWriterPool          = sync.Pool{New: func() any { return gzip.NewWriter(io.Discard) }}
)

// Chain applies middleware in declaration order.
func Chain(handler http.Handler, middleware ...func(http.Handler) http.Handler) http.Handler {
	for i := len(middleware) - 1; i >= 0; i-- {
		handler = middleware[i](handler)
	}
	return handler
}

// RequestID ensures every response has an X-Request-ID header.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := normalizeRequestID(r.Header.Get("X-Request-ID"))
		if requestID == "" {
			requestID = newRequestID()
		}
		w.Header().Set("X-Request-ID", requestID)
		ctx := context.WithValue(r.Context(), responseKey{}, requestID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// SecurityHeaders adds baseline browser hardening headers.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
		if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

// Timeout attaches a deadline to request contexts.
func Timeout(timeout time.Duration) func(http.Handler) http.Handler {
	return TimeoutByRequest(timeout, nil)
}

// TimeoutByRequest attaches a deadline selected for each request.
// Non-positive selected values fall back to defaultTimeout.
func TimeoutByRequest(defaultTimeout time.Duration, selectTimeout func(*http.Request) time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			timeout := defaultTimeout
			if selectTimeout != nil {
				if selected := selectTimeout(r); selected > 0 {
					timeout = selected
				}
			}
			ctx, cancel := context.WithTimeout(r.Context(), timeout)
			defer cancel()
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// CORS handles browser cross-origin requests.
func CORS(origins, methods, headers []string) func(http.Handler) http.Handler {
	allowedOrigins := set(origins)
	allowedMethods := strings.Join(methods, ", ")
	allowedHeaders := strings.Join(headers, ", ")

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && (allowedOrigins["*"] || allowedOrigins[origin]) {
				if allowedOrigins["*"] {
					w.Header().Set("Access-Control-Allow-Origin", "*")
				} else {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Access-Control-Allow-Credentials", "true")
				}
				w.Header().Set("Vary", "Origin")
				w.Header().Set("Access-Control-Allow-Methods", allowedMethods)
				w.Header().Set("Access-Control-Allow-Headers", allowedHeaders)
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// Gzip compresses responses when the client supports gzip.
func Gzip(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/responses" || !acceptsGzip(r.Header.Get("Accept-Encoding")) {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Add("Vary", "Accept-Encoding")
		w.Header().Set("Content-Encoding", "gzip")
		gzw := gzipWriterPool.Get().(*gzip.Writer)
		gzw.Reset(w)
		defer func() {
			_ = gzw.Close()
			gzw.Reset(io.Discard)
			gzipWriterPool.Put(gzw)
		}()
		next.ServeHTTP(gzipResponseWriter{ResponseWriter: w, writer: gzw}, r)
	})
}

func acceptsGzip(value string) bool {
	gzipQuality := -1.0
	wildcardQuality := -1.0
	for len(value) > 0 {
		item := value
		if comma := strings.IndexByte(value, ','); comma >= 0 {
			item = value[:comma]
			value = value[comma+1:]
		} else {
			value = ""
		}
		name, quality := parseEncodingQuality(item)
		switch {
		case strings.EqualFold(name, "gzip"):
			gzipQuality = quality
		case name == "*":
			wildcardQuality = quality
		}
	}
	if gzipQuality >= 0 {
		return gzipQuality > 0
	}
	return wildcardQuality > 0
}

func parseEncodingQuality(item string) (string, float64) {
	item = strings.TrimSpace(item)
	quality := 1.0
	name := item
	if semicolon := strings.IndexByte(item, ';'); semicolon >= 0 {
		name = strings.TrimSpace(item[:semicolon])
		parameters := item[semicolon+1:]
		for len(parameters) > 0 {
			parameter := parameters
			if next := strings.IndexByte(parameters, ';'); next >= 0 {
				parameter = parameters[:next]
				parameters = parameters[next+1:]
			} else {
				parameters = ""
			}
			key, raw, found := strings.Cut(parameter, "=")
			if !found || !strings.EqualFold(strings.TrimSpace(key), "q") {
				continue
			}
			parsed, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
			if err != nil || parsed < 0 || parsed > 1 {
				return name, 0
			}
			quality = parsed
		}
	}
	return name, quality
}

// RequestMetrics records request count, duration, route template, and status class.
func RequestMetrics(store *metrics.Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(recorder, r)
			store.ObserveHTTPRequest(r.Method, metricRoute(r), recorder.status, time.Since(start))
		})
	}
}

func metricRoute(r *http.Request) string {
	pattern := strings.TrimSpace(r.Pattern)
	if pattern != "" {
		if method, route, found := strings.Cut(pattern, " "); found && strings.EqualFold(method, r.Method) {
			return strings.TrimSpace(route)
		}
		return pattern
	}
	if r.Method == http.MethodOptions {
		return "<cors-preflight>"
	}
	return "<unmatched>"
}

// RequestLogger writes one structured log entry per request.
func RequestLogger(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(recorder, r)
			logger.Info(
				"request completed",
				"method", r.Method,
				"path", r.URL.Path,
				"status", recorder.status,
				"duration_ms", time.Since(start).Milliseconds(),
				"request_id", r.Context().Value(responseKey{}),
			)
		})
	}
}

type statusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (r *statusRecorder) WriteHeader(status int) {
	if r.wroteHeader {
		return
	}
	r.wroteHeader = true
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Write(data []byte) (int, error) {
	if !r.wroteHeader {
		r.WriteHeader(http.StatusOK)
	}
	return r.ResponseWriter.Write(data)
}

func (r *statusRecorder) Flush() {
	if !r.wroteHeader {
		r.WriteHeader(http.StatusOK)
	}
	if flusher, ok := r.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (r *statusRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

type gzipResponseWriter struct {
	http.ResponseWriter
	writer *gzip.Writer
}

func (w gzipResponseWriter) WriteHeader(status int) {
	w.Header().Del("Content-Length")
	w.ResponseWriter.WriteHeader(status)
}

func (w gzipResponseWriter) Write(data []byte) (int, error) {
	w.Header().Del("Content-Length")
	return w.writer.Write(data)
}

func (w gzipResponseWriter) Flush() {
	_ = w.writer.Flush()
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w gzipResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func set(values []string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			result[value] = true
		}
	}
	return result
}

func newRequestID() string {
	var data [16]byte
	if _, err := readRequestIDRandom(data[:]); err == nil {
		return hex.EncodeToString(data[:])
	}
	return fmt.Sprintf("%016x%016x", time.Now().UTC().UnixNano(), requestIDFallbackSerial.Add(1))
}

func normalizeRequestID(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maxRequestIDLength {
		return ""
	}
	for _, r := range value {
		if !isRequestIDChar(r) {
			return ""
		}
	}
	return value
}

func isRequestIDChar(r rune) bool {
	return (r >= 'a' && r <= 'z') ||
		(r >= 'A' && r <= 'Z') ||
		(r >= '0' && r <= '9') ||
		r == '-' ||
		r == '_' ||
		r == '.' ||
		r == ':' ||
		r == '/'
}
