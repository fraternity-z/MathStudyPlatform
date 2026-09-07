package config

import (
	"fmt"
	"io"
	"os"
	"strings"
)

// File secrets are resolved without copying them into process environment or logs.
func loadSecretFiles(cfg *Config) error {
	for _, entry := range []struct {
		name  string
		value *string
	}{
		{"POSTGRES_PASSWORD", &cfg.PostgresPassword},
		{"REDIS_PASSWORD", &cfg.RedisPassword},
		{"JWT_SECRET_KEY", &cfg.JWTSecretKey},
		{"ADMIN_PASSWORD", &cfg.AdminPassword},
		{"FERNET_SECRET_KEY", &cfg.FernetSecretKey},
		{"QDRANT_API_KEY", &cfg.QdrantAPIKey},
	} {
		path := strings.TrimSpace(os.Getenv(entry.name + "_FILE"))
		if path == "" {
			continue
		}
		if strings.TrimSpace(os.Getenv(entry.name)) != "" {
			return fmt.Errorf("%s and %s_FILE must not both be configured", entry.name, entry.name)
		}
		value, err := readSecretFile(path)
		if err != nil {
			return fmt.Errorf("%s_FILE must reference a readable, nonempty secret of at most 16 KiB", entry.name)
		}
		*entry.value = value
	}
	return nil
}

func readSecretFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("invalid secret file")
	}
	data, err := io.ReadAll(io.LimitReader(f, (16<<10)+1))
	if err != nil || len(data) > 16<<10 {
		return "", fmt.Errorf("invalid secret size")
	}
	value := strings.TrimSpace(string(data))
	if value == "" || strings.ContainsAny(value, "\x00\r\n") {
		return "", fmt.Errorf("invalid secret value")
	}
	return value, nil
}
