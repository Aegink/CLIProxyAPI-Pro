package executor

import (
	"context"
	"net/http"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/proxyutil"
)

func antigravityHTTP11Transport(auth *cliproxyauth.Auth, base *http.Transport, cfgs ...*config.Config) *http.Transport {
	var cfg *config.Config
	if len(cfgs) > 0 {
		cfg = cfgs[0]
	}
	resolution := proxyutil.ResolveEffectiveProxy(antigravityProxyURL(context.Background(), cfg, auth))
	return antigravityHTTP11TransportResolved(auth, base, resolution, cfgs...)
}

func antigravityProxiedHTTP11Transport(auth *cliproxyauth.Auth, proxyURL string, cfgs ...*config.Config) *http.Transport {
	return antigravityProxiedHTTP11TransportResolved(auth, proxyutil.ResolveEffectiveProxy(proxyURL), cfgs...)
}
