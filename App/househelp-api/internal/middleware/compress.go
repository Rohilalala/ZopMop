package middleware

import (
	"bytes"
	"compress/gzip"
	"strings"
	"sync"

	"github.com/gofiber/fiber/v2"
)

// gzipMinBytes is the response-size floor for compression. Bodies smaller than
// this are passed through uncompressed: gzip framing alone is ~20 bytes and
// the CPU cost of compressing tiny payloads (rate-limit error JSON, health
// pings) is not recovered by any meaningful byte reduction. Tuned from pprof
// observation that fiber's `compress` middleware was burning ~23% CPU on
// 429 error bodies during a single-IP loopback storm.
const gzipMinBytes = 1024

// gzipPool reuses gzip.Writer instances across requests. Allocating a fresh
// gzip.Writer per response triggers ~30 KiB of allocations from the
// flate.Writer's hash tables; pooling drops that to one allocation per OS
// thread plus body-sized scratch buffers.
var gzipPool = sync.Pool{
	New: func() any {
		// Bound output buffer initial size at 1 KiB — most compressible JSON
		// responses fit in one chunk; larger ones grow naturally.
		gw, _ := gzip.NewWriterLevel(nil, gzip.BestSpeed)
		return gw
	},
}

// CompressIfLarge returns a Fiber handler that gzips response bodies only when
// they exceed gzipMinBytes AND the client advertises gzip support. Bodies
// already carrying a Content-Encoding header (e.g. pre-compressed assets)
// pass through untouched. Vary: Accept-Encoding is always set on a
// compress-eligible response so caches partition by encoding.
func CompressIfLarge() fiber.Handler {
	return func(c *fiber.Ctx) error {
		if err := c.Next(); err != nil {
			return err
		}
		body := c.Response().Body()
		if len(body) < gzipMinBytes {
			return nil
		}
		// If the handler (or an upstream middleware) already encoded, leave it.
		if len(c.Response().Header.Peek(fiber.HeaderContentEncoding)) > 0 {
			return nil
		}
		ae := c.Get(fiber.HeaderAcceptEncoding)
		if !strings.Contains(ae, "gzip") {
			return nil
		}

		gw := gzipPool.Get().(*gzip.Writer)
		var buf bytes.Buffer
		gw.Reset(&buf)
		if _, werr := gw.Write(body); werr != nil {
			gzipPool.Put(gw)
			return nil
		}
		if cerr := gw.Close(); cerr != nil {
			gzipPool.Put(gw)
			return nil
		}
		gzipPool.Put(gw)

		c.Response().SetBody(buf.Bytes())
		c.Response().Header.Set(fiber.HeaderContentEncoding, "gzip")
		c.Response().Header.Add(fiber.HeaderVary, fiber.HeaderAcceptEncoding)
		c.Response().Header.SetContentLength(buf.Len())
		return nil
	}
}
