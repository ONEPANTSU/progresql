package rest

import "net/http"

// CORSMiddleware adds the necessary CORS headers so that the Electron renderer
// (running on a different port or origin) can reach the backend API.
// It also handles OPTIONS preflight requests.
func CORSMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "" {
			// No CORS involved — regular same-origin or non-browser request.
			next.ServeHTTP(w, r)
			return
		}

		// Allow any localhost origin (Electron dev or packaged).
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Access-Control-Max-Age", "86400")

		// Preflight request — respond immediately.
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}
