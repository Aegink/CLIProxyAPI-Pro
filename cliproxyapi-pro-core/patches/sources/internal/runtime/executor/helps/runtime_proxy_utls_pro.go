package helps

import (
	"net/http"

	"github.com/router-for-me/CLIProxyAPI/v7/sdk/proxyutil"
)

func newUtlsRoundTripper(proxyURL string) *utlsRoundTripper {
	return newUtlsRoundTripperResolved(proxyutil.ResolveEffectiveProxy(proxyURL).Effective)
}

type claudeCodeRoundTripperKey struct {
	effective  string
	generation uint64
}

func cachedClaudeCodeRoundTripper(proxyURL string) http.RoundTripper {
	return cachedClaudeCodeRoundTripperResolved(proxyutil.ResolveEffectiveProxy(proxyURL))
}

func newClaudeCodeRoundTripper(proxyURL string) http.RoundTripper {
	return newClaudeCodeRoundTripperResolved(proxyutil.ResolveEffectiveProxy(proxyURL).Effective)
}
