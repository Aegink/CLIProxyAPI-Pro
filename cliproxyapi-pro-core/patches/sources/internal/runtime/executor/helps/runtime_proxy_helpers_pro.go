package helps

import (
	"net/http"

	"github.com/router-for-me/CLIProxyAPI/v7/sdk/proxyutil"
)

type runtimeProxyTransportKey struct {
	scope      string
	generation uint64
}

func buildProxyTransport(proxyURL string) *http.Transport {
	return buildResolvedProxyTransport(proxyutil.ResolveEffectiveProxy(proxyURL))
}
