package executor

import (
	"context"
	"fmt"
	"net/http"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor/helps"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v7/sdk/translator"
)

// translateNonStreamResponse turns translator panics into an ordinary executor
// error. Executors can then publish the buffered upstream usage as a failed
// terminal record instead of allowing an earlier success publication to win.
func translateNonStreamResponse(
	ctx context.Context,
	from sdktranslator.Format,
	to sdktranslator.Format,
	model string,
	originalRequest []byte,
	translatedRequest []byte,
	response []byte,
	param *any,
) (out []byte, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			out = nil
			err = statusErr{
				code: http.StatusBadGateway,
				msg:  fmt.Sprintf("response translation failed: %v", recovered),
			}
		}
	}()
	out = sdktranslator.TranslateNonStream(ctx, from, to, model, originalRequest, translatedRequest, response, param)
	return out, nil
}

func publishApplyPatchStreamFailureWithUsage(ctx context.Context, param any, reporter *helps.UsageReporter, buffer *helps.StreamUsageBuffer, gatewayErr error) {
	if helps.ApplyPatchTranslationError(param) != nil {
		if !buffer.PublishFailure(ctx, reporter, gatewayErr) {
			reporter.PublishFailure(ctx, gatewayErr)
		}
	}
}

// Adapt only finalization's accounting hook. Upstream still owns final chunk
// delivery, error propagation, and cancellation through EndApplyPatchStream.
// FinalizeToolInput consumes the underlying state's terminal chunks once.
type applyPatchStreamUsageState struct {
	ctx        context.Context
	param      any
	reporter   *helps.UsageReporter
	buffer     *helps.StreamUsageBuffer
	gatewayErr error
}

func (s applyPatchStreamUsageState) ToolInputError() error {
	return helps.ApplyPatchTranslationError(s.param)
}

func (s applyPatchStreamUsageState) FinalizeToolInput() [][]byte {
	chunks := helps.FinalizeApplyPatchStream(s.param)
	publishApplyPatchStreamFailureWithUsage(s.ctx, s.param, s.reporter, s.buffer, s.gatewayErr)
	return chunks
}

func endApplyPatchStreamWithUsage(ctx context.Context, param any, reporter *helps.UsageReporter, out chan<- cliproxyexecutor.StreamChunk, buffer *helps.StreamUsageBuffer, gatewayErr error) bool {
	state := applyPatchStreamUsageState{ctx: ctx, param: param, reporter: reporter, buffer: buffer, gatewayErr: gatewayErr}
	return helps.EndApplyPatchStream(ctx, state, reporter, out, gatewayErr)
}
