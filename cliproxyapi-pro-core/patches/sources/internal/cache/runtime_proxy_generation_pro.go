package cache

import "sync/atomic"

// SyncGeneration advances an owner's generation and purges its cache only when
// this call wins the update. Each owner retains its cache keys and purge callback.
func SyncGeneration(current *atomic.Uint64, generation uint64, purge func()) {
	for {
		observed := current.Load()
		if observed >= generation {
			return
		}
		if current.CompareAndSwap(observed, generation) {
			purge()
			return
		}
	}
}
