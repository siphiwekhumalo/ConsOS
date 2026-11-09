package syncapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/constructos/sync-service/internal/auth"
)

var pushRoles = map[string]bool{"owner": true, "admin": true, "project_manager": true, "site_foreman": true}

type Handler struct {
	store *Store
	log   *slog.Logger
}

// NewRouter wires the public sync API. All routes except health need a bearer token.
func NewRouter(store *Store, verifier *auth.Verifier, log *slog.Logger) http.Handler {
	h := &Handler{store: store, log: log}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /sync/health", h.health)
	mux.Handle("POST /sync/v1/push", verifier.Middleware(http.HandlerFunc(h.push)))
	mux.Handle("GET /sync/v1/pull", verifier.Middleware(http.HandlerFunc(h.pull)))
	return h.logging(mux)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func errorJSON(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"statusCode": status, "message": msg})
}

func (h *Handler) health(w http.ResponseWriter, r *http.Request) {
	if err := h.store.Ping(r.Context()); err != nil {
		errorJSON(w, http.StatusServiceUnavailable, "db_unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// requireField checks the tenant still subscribes to Field Operations.
func (h *Handler) requireField(w http.ResponseWriter, r *http.Request, p auth.Principal) bool {
	ok, err := h.store.HasModule(r.Context(), p.TenantID, "mod_field")
	if err != nil {
		h.log.Error("entitlement check failed", "err", err)
		errorJSON(w, http.StatusInternalServerError, "internal error")
		return false
	}
	if !ok {
		errorJSON(w, http.StatusForbidden, "Module mod_field is not active for your organisation")
		return false
	}
	return true
}

func (h *Handler) push(w http.ResponseWriter, r *http.Request) {
	p, _ := auth.FromContext(r.Context())
	if !pushRoles[p.Role] {
		errorJSON(w, http.StatusForbidden, "Your role does not permit this action")
		return
	}
	if !h.requireField(w, r, p) {
		return
	}

	var req PushRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, MaxBodyBytes))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			errorJSON(w, http.StatusRequestEntityTooLarge, "batch too large")
			return
		}
		errorJSON(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if req.DeviceID == "" || len(req.DeviceID) > 100 {
		errorJSON(w, http.StatusBadRequest, "deviceId is required (max 100 chars)")
		return
	}
	if len(req.Mutations) == 0 || len(req.Mutations) > MaxMutationsPerPush {
		errorJSON(w, http.StatusBadRequest, "mutations must contain 1-"+strconv.Itoa(MaxMutationsPerPush)+" items")
		return
	}

	resp := PushResponse{Results: make([]MutationResult, 0, len(req.Mutations)), Summary: map[string]int{}}
	for _, m := range req.Mutations {
		res := h.store.Apply(r.Context(), p, req.DeviceID, m)
		resp.Results = append(resp.Results, res)
		resp.Summary[res.Status]++
	}
	if resp.Summary[StatusApplied] > 0 || resp.Summary[StatusConflict] > 0 {
		if err := h.store.RecordBatch(r.Context(), p, req.DeviceID, resp.Summary); err != nil {
			h.log.Error("audit append failed", "err", err, "tenant", p.TenantID)
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) pull(w http.ResponseWriter, r *http.Request) {
	p, _ := auth.FromContext(r.Context())
	if !h.requireField(w, r, p) {
		return
	}
	since, err := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	if r.URL.Query().Get("since") == "" {
		since, err = 0, nil
	}
	if err != nil || since < 0 {
		errorJSON(w, http.StatusBadRequest, "since must be a non-negative integer cursor")
		return
	}
	limit := DefaultPullLimit
	if l := r.URL.Query().Get("limit"); l != "" {
		if limit, err = strconv.Atoi(l); err != nil || limit < 1 || limit > MaxPullLimit {
			errorJSON(w, http.StatusBadRequest, "limit must be 1-"+strconv.Itoa(MaxPullLimit))
			return
		}
	}
	out, err := h.store.Pull(r.Context(), p.TenantID, since, limit)
	if err != nil {
		h.log.Error("pull failed", "err", err, "tenant", p.TenantID)
		errorJSON(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (h *Handler) logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		if r.URL.Path != "/sync/health" {
			h.log.Info("request", "method", r.Method, "path", r.URL.Path, "status", rec.status,
				"ms", time.Since(start).Milliseconds())
		}
	})
}
