package claude

import (
	tls "github.com/refraction-networking/utls"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/proxyutil"
)

type claudeOAuthSessionCacheKey struct {
	effective  string
	generation uint64
}

func claudeOAuthSessionCache(proxyURL string) tls.ClientSessionCache {
	return claudeOAuthSessionCacheResolved(proxyutil.ResolveEffectiveProxy(proxyURL))
}
